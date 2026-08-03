"""Offline tests for run_eval prompt construction with the dataset tag."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import run_eval  # noqa: E402


class TestBuildPrompt:
    def test_preview_prompt_has_no_data_hint(self) -> None:
        prompt = run_eval.build_prompt({"id": "hb001", "question": "Which organ?"}, dataset="preview", cache_dir="/cache")
        assert "Which organ?" in prompt
        assert "[Data files" not in prompt
        assert "hb001.zip" not in prompt

    def test_full_prompt_attaches_data_hint_when_zip_present(self, tmp_path: Path) -> None:
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        (data_dir / "hb001.zip").write_bytes(b"x")
        prompt = run_eval.build_prompt({"id": "hb001", "question": "Which organ?"}, dataset="full", cache_dir=str(tmp_path))
        assert "Which organ?" in prompt
        assert "hb001.zip" in prompt
        assert str(data_dir / "hb001.zip") in prompt

    def test_full_prompt_notes_missing_zip(self, tmp_path: Path) -> None:
        prompt = run_eval.build_prompt({"id": "hb001", "question": "Which organ?"}, dataset="full", cache_dir=str(tmp_path))
        assert "Which organ?" in prompt
        assert "[data file not downloaded: hb001.zip]" in prompt
        assert "hb001.zip; use them" not in prompt

    def test_default_dataset_is_preview(self) -> None:
        prompt = run_eval.build_prompt({"id": "hb001", "question": "Q?"})
        assert "[Data files" not in prompt


class TestLoadDatasetTag:
    def test_fixture_array_is_preview(self) -> None:
        assert run_eval.load_dataset_tag(str(ROOT / "fixtures" / "sample_questions.json")) == "preview"

    def test_dict_with_dataset_field(self, tmp_path: Path) -> None:
        target = tmp_path / "problems.json"
        target.write_text(json.dumps({"dataset": "full", "problems": []}), encoding="utf-8")
        assert run_eval.load_dataset_tag(str(target)) == "full"

    def test_dict_without_dataset_field_is_preview(self, tmp_path: Path) -> None:
        target = tmp_path / "problems.json"
        target.write_text(json.dumps({"problems": []}), encoding="utf-8")
        assert run_eval.load_dataset_tag(str(target)) == "preview"

    def test_missing_file_is_preview(self) -> None:
        assert run_eval.load_dataset_tag("/nonexistent/problems.json") == "preview"

    def test_broken_json_is_preview(self, tmp_path: Path) -> None:
        target = tmp_path / "broken.json"
        target.write_text("{not json", encoding="utf-8")
        assert run_eval.load_dataset_tag(str(target)) == "preview"
