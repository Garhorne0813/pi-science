"""Offline trigger and workflow fixture evaluation for skills."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _terms(skill_name: str, description: str) -> set[str]:
    values = {skill_name.lower()}
    values.update(token.lower() for token in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", description))
    return values


def evaluate_skill(skill_name: str, description: str, fixtures: list[dict[str, Any]]) -> dict[str, Any]:
    terms = _terms(skill_name, description)
    rows: list[dict[str, Any]] = []
    true_positive = false_positive = false_negative = 0
    for fixture in fixtures:
        prompt = str(fixture.get("prompt") or "")
        expected = bool(fixture.get("expected_trigger", False))
        trigger_terms = {str(item).lower() for item in fixture.get("trigger_terms", [])}
        actual = bool(trigger_terms & {token.lower() for token in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", prompt)}) if trigger_terms else bool(terms & set(re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", prompt.lower())))
        if actual and expected:
            true_positive += 1
        elif actual and not expected:
            false_positive += 1
        elif not actual and expected:
            false_negative += 1
        required_outputs = [str(item) for item in fixture.get("required_outputs", [])]
        produced_outputs = {str(item) for item in fixture.get("produced_outputs", [])}
        missing_outputs = [item for item in required_outputs if item not in produced_outputs]
        rows.append({"prompt": prompt, "expected": expected, "actual": actual, "missing_outputs": missing_outputs, "pass": expected == actual and not missing_outputs})
    precision = true_positive / (true_positive + false_positive) if true_positive + false_positive else 1.0
    recall = true_positive / (true_positive + false_negative) if true_positive + false_negative else 1.0
    return {
        "skill": skill_name,
        "cases": len(fixtures),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "passed": sum(1 for row in rows if row["pass"]),
        "failed": sum(1 for row in rows if not row["pass"]),
        "rows": rows,
    }


def load_fixtures(path: str | Path) -> list[dict[str, Any]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("skill fixtures must be a JSON array")
    return [item for item in payload if isinstance(item, dict)]
