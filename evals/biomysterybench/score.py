#!/usr/bin/env python3
"""Score a completed evaluation run.

Reads runs/<timestamp>/record.jsonl and produces:
- score.json: per-sample status plus an auto verdict when a reference answers
  file is provided (--answers: JSON mapping sample_id -> [accepted fragments])
- score.md: human scoring template (the primary path for benchmark rubrics,
  which require human judgment)

Rubric text is read from the fetched dataset at scoring time and never
committed to the repository.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from bmb.scoring import load_records, render_human_template, score_against_answers

ROOT = Path(__file__).resolve().parent


def _load_json_or_exit(path: Path, label: str) -> dict:
    """Load a JSON file, exiting with a friendly message when missing/unreadable."""
    if not path.exists():
        raise SystemExit(f"[score] {label} not found: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"[score] cannot read {label} {path}: {exc}")
    if not isinstance(payload, dict):
        raise SystemExit(f"[score] {label} must contain a JSON object: {path}")
    return payload


def main_args(run_dir: str, answers: str | None, rubrics: str | None) -> None:
    """Score a run directory; separated from argparse so tests can call it directly."""
    run_path = Path(run_dir)
    if not (run_path / "record.jsonl").exists():
        raise SystemExit(f"[score] run directory has no record.jsonl: {run_path}")
    records = load_records(run_path)

    rubric_payload: dict[str, str] = {}
    if rubrics:
        rubric_payload = _load_json_or_exit(Path(rubrics), "rubrics file")
    else:
        problems_path = ROOT / ".cache" / "problems.json"
        if problems_path.exists():
            try:
                payload = json.loads(problems_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = {}
            if isinstance(payload, dict):
                rubric_payload = {p["id"]: p.get("answer_rubric", "") for p in payload.get("problems", [])}

    score_result: dict[str, object] = {
        "run": str(run_path),
        "score_version": json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["score_version"],
        "records": len(records),
        "samples": [],
    }
    if answers:
        answers_payload = _load_json_or_exit(Path(answers), "answers file")
        for record in records:
            score_result["samples"].append(score_against_answers(record, answers_payload))  # type: ignore[arg-type]

    (run_path / "score.json").write_text(json.dumps(score_result, ensure_ascii=False, indent=2), encoding="utf-8")
    (run_path / "score.md").write_text(render_human_template(records, rubric_payload), encoding="utf-8")
    print(f"[score] {len(records)} records -> {run_path / 'score.json'} and {run_path / 'score.md'}")
    if answers:
        for sample in score_result["samples"]:
            print(f"  {sample['sample_id']}: {sample['auto_verdict']} ({sample['reason']})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score a completed evaluation run")
    parser.add_argument("--run", required=True, help="run directory containing record.jsonl")
    parser.add_argument("--answers", default=None,
                        help="JSON mapping sample_id -> [accepted fragments] for auto verdicts")
    parser.add_argument("--rubrics", default=None,
                        help="JSON mapping sample_id -> rubric text (default: cache problems.json)")
    args = parser.parse_args()
    main_args(args.run, args.answers, args.rubrics)


if __name__ == "__main__":
    main()
