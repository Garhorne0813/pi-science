"""Offline tests: record schema, hashing, scoring, smoke pipeline, manifest."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bmb.hashutil import sha256_file, sha256_text  # noqa: E402
from bmb.schema import normalize_record, validate_record  # noqa: E402
from bmb.scoring import render_human_template, score_against_answers  # noqa: E402


def valid_record() -> dict:
    return normalize_record(
        {
            "sample_id": "syn-001",
            "model": "fake-model-smoke",
            "prompt": "question",
            "seed": 42,
            "started_at": 1,
            "finished_at": 2,
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            "estimated_cost_usd": 0.0,
            "response": "42",
            "response_sha256": sha256_text("42"),
            "status": "ok",
        }
    )


class TestHashUtil:
    def test_sha256_text_known_value(self) -> None:
        assert sha256_text("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assert sha256_text("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

    def test_sha256_file_matches_known_bytes(self, tmp_path: Path) -> None:
        target = tmp_path / "sample.txt"
        target.write_bytes(b"pi-science")
        assert sha256_file(target) == "fe8cf8d9a1a062d60584889a2405d2077dc6cc95a31e646826af8a9ac0a5eab4"


class TestSchema:
    def test_valid_record_passes(self) -> None:
        assert validate_record(valid_record()) == []

    def test_missing_field_detected(self) -> None:
        record = valid_record()
        del record["response"]
        assert "missing field: response" in validate_record(record)

    def test_bad_status_detected(self) -> None:
        record = valid_record()
        record["status"] = "wat"
        assert "status must be one of" in validate_record(record)[0]

    def test_usage_field_type_detected(self) -> None:
        record = valid_record()
        record["usage"]["total_tokens"] = "8"
        assert "usage.total_tokens must be an int" in validate_record(record)

    def test_normalize_fills_defaults(self) -> None:
        record = normalize_record({"sample_id": "x", "status": "ok"})
        assert record["usage"] == {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        assert record["estimated_cost_usd"] is None


class TestScoring:
    def test_include_match_pass(self) -> None:
        record = {"sample_id": "syn-001", "response": "The answer is 42 exactly."}
        result = score_against_answers(record, {"syn-001": ["42"]})
        assert result["auto_verdict"] == "pass"

    def test_include_match_fail(self) -> None:
        record = {"sample_id": "syn-001", "response": "I am not sure."}
        result = score_against_answers(record, {"syn-001": ["42"]})
        assert result["auto_verdict"] == "fail"

    def test_missing_answers_yields_none(self) -> None:
        record = {"sample_id": "syn-002", "response": "anything"}
        result = score_against_answers(record, {"syn-001": ["42"]})
        assert result["auto_verdict"] is None

    def test_human_template_contains_samples(self) -> None:
        records = [{"sample_id": "syn-001", "model": "m", "response": "42"}]
        template = render_human_template(records, {"syn-001": "rubric text"})
        assert "## syn-001" in template
        assert "rubric text" in template
        assert "score (0-5)" in template


class TestManifest:
    def test_manifest_static_metadata_present(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        assert manifest["dataset"] == "Anthropic/BioMysteryBench-preview"
        assert len(manifest["revision"]) == 40  # pinned git sha
        assert manifest["license"] == "cc-by-4.0"
        for name, meta in manifest["files"].items():
            assert len(meta["sha256"]) == 64
            assert meta["size"] > 0

    def test_fixtures_are_synthetic(self) -> None:
        fixtures = json.loads((ROOT / "fixtures" / "sample_questions.json").read_text(encoding="utf-8"))
        assert 2 <= len(fixtures) <= 3
        assert all(p["id"].startswith("syn-") for p in fixtures)
