#!/usr/bin/env python3
"""Run a BioMysteryBench evaluation.

Reads problems (JSON array or the cache problems.json produced by
fetch_dataset.py), calls the configured OpenAI-compatible endpoint for each
sample, and writes a JSONL record file plus meta.json into
runs/<timestamp>/. Records carry full provenance: prompt, seed, timestamps,
token usage, estimated cost, response and its sha256.

`--smoke` runs the same pipeline end-to-end against synthetic fixtures with a
deterministic FakeModel — no network, no API key. This is the CI-safe path.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
from pathlib import Path

from bmb.hashutil import sha256_text
from bmb.llm import LLMClient, FakeModel, OpenAIClient, estimate_cost_usd
from bmb.schema import normalize_record, validate_record

ROOT = Path(__file__).resolve().parent
SMOKE_DATA = ROOT / "fixtures" / "sample_questions.json"

PROMPT_TEMPLATE = (
    "Solve the following research problem. Analyze any provided data if needed "
    "and answer concisely with the final answer.\n\n{question}"
)


def load_problems(data: str | Path, limit: int | None) -> list[dict]:
    path = Path(data)
    if not path.exists() and not data.startswith("["):
        raise SystemExit(f"data file not found: {data}")
    raw = path.read_text(encoding="utf-8") if path.exists() else data
    payload = json.loads(raw)
    if isinstance(payload, dict) and "problems" in payload:
        problems = payload["problems"]
    else:
        problems = payload
    if limit is not None:
        problems = problems[:limit]
    return problems


def make_client(args: argparse.Namespace) -> LLMClient:
    if args.smoke:
        return FakeModel(args.model or "fake-model-smoke")
    base_url = args.base_url or os.environ.get("PI_EVAL_BASE_URL")
    api_key = args.api_key or os.environ.get("PI_EVAL_API_KEY")
    if not base_url or not api_key:
        raise SystemExit(
            "PI_EVAL_BASE_URL and PI_EVAL_API_KEY are required (or use --smoke)"
        )
    return OpenAIClient(base_url, api_key, args.model or "claude-sonnet-4-5")


def run(args: argparse.Namespace) -> Path:
    problems = load_problems(args.data, args.limit)
    client = make_client(args)
    out_dir = Path(args.out) if args.out else (ROOT / "runs" / time.strftime("%Y%m%dT%H%M%SZ"))
    out_dir.mkdir(parents=True, exist_ok=True)
    record_path = out_dir / "record.jsonl"

    with open(record_path, "w", encoding="utf-8") as handle:
        for problem in problems:
            sample_id = problem["id"]
            prompt = PROMPT_TEMPLATE.format(question=problem["question"])
            try:
                response, usage, started, finished = client.complete(prompt, args.seed)
                status = "ok"
            except Exception as error:  # record errors, keep going
                response = f"<error> {error}"
                usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                started = finished = int(time.time() * 1000)
                status = "error"
            record = normalize_record(
                {
                    "sample_id": sample_id,
                    "model": client.model,
                    "prompt": prompt,
                    "seed": args.seed,
                    "started_at": started,
                    "finished_at": finished,
                    "usage": usage,
                    "estimated_cost_usd": estimate_cost_usd(
                        client.model, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
                    ),
                    "response": response,
                    "response_sha256": sha256_text(response),
                    "status": status,
                }
            )
            violations = validate_record(record)
            if violations:
                raise SystemExit(f"internal record schema violation: {violations}")
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            print(f"[run] {sample_id}: {status} ({record['usage']['total_tokens']} tokens)")

    meta = {
        "model": client.model,
        "seed": args.seed,
        "smoke": args.smoke,
        "limit": args.limit,
        "problems": len(problems),
        "record_count": len(problems),
        "started_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[run] done: {len(problems)} records -> {out_dir}")
    return out_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Run BioMysteryBench evaluation")
    parser.add_argument("--data", default=str(ROOT / ".cache" / "problems.json"),
                        help="problems JSON (array or {problems:[...]}) or a JSON file path")
    parser.add_argument("--smoke", action="store_true", help="offline deterministic run on synthetic fixtures")
    parser.add_argument("--model", default=None, help="model id (default: env/model or fake in smoke)")
    parser.add_argument("--base-url", default=None, help="OpenAI-compatible base URL (or PI_EVAL_BASE_URL)")
    parser.add_argument("--api-key", default=None, help="API key (or PI_EVAL_API_KEY)")
    parser.add_argument("--limit", type=int, default=None, help="only evaluate the first N problems")
    parser.add_argument("--seed", type=int, default=42, help="determinism seed passed to the endpoint")
    parser.add_argument("--out", default=None, help="output directory (default: runs/<timestamp>)")
    args = parser.parse_args()
    if args.smoke:
        args.data = str(SMOKE_DATA)
    run(args)


if __name__ == "__main__":
    main()
