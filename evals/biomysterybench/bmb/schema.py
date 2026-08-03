"""Record schema and validation for evaluation runs.

One JSON record per model response, written as JSONL into
`runs/<timestamp>/record.jsonl`.
"""

from __future__ import annotations

from typing import Any

REQUIRED_FIELDS = [
    "sample_id",
    "model",
    "prompt",
    "seed",
    "started_at",
    "finished_at",
    "usage",
    "estimated_cost_usd",
    "response",
    "response_sha256",
    "status",
]

USAGE_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens"]

STATUS_VALUES = {"ok", "error", "skipped"}


def validate_record(record: dict[str, Any]) -> list[str]:
    """Return a list of schema violations (empty when the record is valid)."""
    errors: list[str] = []
    for field in REQUIRED_FIELDS:
        if field not in record:
            errors.append(f"missing field: {field}")
    if "usage" in record:
        usage = record["usage"]
        if not isinstance(usage, dict):
            errors.append("usage must be an object")
        else:
            for field in USAGE_FIELDS:
                if field not in usage:
                    errors.append(f"missing usage field: {field}")
                elif not isinstance(usage[field], int):
                    errors.append(f"usage.{field} must be an int")
    if "status" in record and record["status"] not in STATUS_VALUES:
        errors.append(f"status must be one of {sorted(STATUS_VALUES)}")
    for field in ("seed",):
        if field in record and not isinstance(record[field], int):
            errors.append(f"{field} must be an int")
    for field in ("estimated_cost_usd",):
        if field in record and record[field] is not None and not isinstance(record[field], (int, float)):
            errors.append(f"{field} must be a number or null")
    if "response_sha256" in record and not isinstance(record["response_sha256"], str):
        errors.append("response_sha256 must be a string")
    return errors


def normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    """Fill optional defaults so a record always carries the full schema.

    A malformed ``usage`` that is not an object is replaced with the default
    usage dict (validation reports the violation via ``validate_record``
    instead of crashing with AttributeError).
    """
    normalized = dict(record)
    if not isinstance(normalized.get("usage"), dict):
        normalized["usage"] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    else:
        normalized["usage"] = dict(normalized["usage"])
    for field in USAGE_FIELDS:
        normalized["usage"].setdefault(field, 0)
    normalized.setdefault("estimated_cost_usd", None)
    normalized.setdefault("response_sha256", "")
    return normalized
