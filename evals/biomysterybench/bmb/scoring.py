"""Scoring.

Two modes:
- `score_against_answers`: deterministic include-style match when a reference
  answer or keyword list is supplied (fixtures / curated answers file).
- `render_human_template`: emits a markdown rubric template for human scoring
  (the primary path for the real benchmark, whose rubrics need human judgment).

Benchmark answer_rubric content is eval-only material: it is read at scoring
time from the fetched dataset and never committed to this repository.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def score_against_answers(record: dict[str, Any], answers: dict[str, list[str]]) -> dict[str, Any]:
    """Case-insensitive include match. answers maps sample_id -> list of accepted fragments."""
    sample_id = record["sample_id"]
    fragments = answers.get(sample_id)
    response = record.get("response") or ""
    if fragments is None:
        return {"sample_id": sample_id, "auto_verdict": None, "reason": "no reference fragments"}

    lowered = response.lower()
    hits = [fragment for fragment in fragments if fragment.lower() in lowered]
    return {
        "sample_id": sample_id,
        "auto_verdict": "pass" if hits else "fail",
        "reason": f"matched fragments: {hits}" if hits else "no fragment matched",
    }


def render_human_template(records: list[dict[str, Any]], rubrics: dict[str, str]) -> str:
    lines = ["# BioMysteryBench human scoring sheet", ""]
    lines.append("Score each item 0-5; 5 = fully correct answer with sound reasoning.")
    lines.append("")
    for record in records:
        sample_id = record["sample_id"]
        lines.append(f"## {sample_id}")
        lines.append("")
        lines.append(f"- model: `{record['model']}`")
        lines.append(f"- rubric: {rubrics.get(sample_id, '(none)')}")
        lines.append("")
        lines.append("**model output**:")
        lines.append("")
        lines.append("```text")
        lines.append((record.get("response") or "").strip()[:2000])
        lines.append("```")
        lines.append("")
        lines.append("- score (0-5): ")
        lines.append("- notes: ")
        lines.append("")
    return "\n".join(lines)


def load_records(run_dir: str | Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    path = Path(run_dir) / "record.jsonl"
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records
