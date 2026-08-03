"""Tests for score.py CLI guards and schema type defense."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bmb.schema import normalize_record, validate_record  # noqa: E402
import score as score_module  # noqa: E402


class TestNormalizeUsageDefense:
    def test_non_dict_usage_replaced_with_defaults(self) -> None:
        record = normalize_record({"sample_id": "x", "status": "ok", "usage": "oops"})
        assert record["usage"] == {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def test_non_dict_usage_still_reported_by_validate(self) -> None:
        # validate_record must report malformed usage on the raw record
        # (normalize_record already repairs it, so this checks the raw path).
        record = {"sample_id": "x", "status": "ok", "usage": "oops"}
        assert "usage must be an object" in validate_record(record)

    def test_usage_dict_not_mutated_by_normalize(self) -> None:
        usage = {"prompt_tokens": 1}
        normalize_record({"sample_id": "x", "status": "ok", "usage": usage})
        assert usage == {"prompt_tokens": 1}


class TestScoreCliGuards:
    def test_missing_answers_file_exits_friendly(self, tmp_path: Path) -> None:
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        (run_dir / "record.jsonl").write_text("", encoding="utf-8")
        missing = tmp_path / "no-such-answers.json"
        with pytest.raises(SystemExit) as exc:
            score_module.main_args(
                run_dir=str(run_dir),
                answers=str(missing),
                rubrics=None,
            )
        message = str(exc.value)
        assert "answers file not found" in message
        assert str(missing) in message

    def test_missing_rubrics_file_exits_friendly(self, tmp_path: Path) -> None:
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        (run_dir / "record.jsonl").write_text("", encoding="utf-8")
        missing = tmp_path / "no-such-rubrics.json"
        with pytest.raises(SystemExit) as exc:
            score_module.main_args(
                run_dir=str(run_dir),
                answers=None,
                rubrics=str(missing),
            )
        assert "rubrics file not found" in str(exc.value)

    def test_run_without_record_jsonl_exits_friendly(self, tmp_path: Path) -> None:
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        with pytest.raises(SystemExit) as exc:
            score_module.main_args(run_dir=str(empty_dir), answers=None, rubrics=None)
        assert "has no record.jsonl" in str(exc.value)

    def test_invalid_answers_json_exits_friendly(self, tmp_path: Path) -> None:
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        (run_dir / "record.jsonl").write_text("", encoding="utf-8")
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        with pytest.raises(SystemExit) as exc:
            score_module.main_args(run_dir=str(run_dir), answers=str(bad), rubrics=None)
        assert "cannot read answers file" in str(exc.value)

    def test_answers_file_must_be_object(self, tmp_path: Path) -> None:
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        (run_dir / "record.jsonl").write_text("", encoding="utf-8")
        list_file = tmp_path / "list.json"
        list_file.write_text("[]", encoding="utf-8")
        with pytest.raises(SystemExit) as exc:
            score_module.main_args(run_dir=str(run_dir), answers=str(list_file), rubrics=None)
        assert "must contain a JSON object" in str(exc.value)
