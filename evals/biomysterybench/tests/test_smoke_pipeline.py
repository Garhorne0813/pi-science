"""End-to-end smoke pipeline test: run_eval --smoke + score, fully offline."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from bmb.schema import validate_record  # noqa: E402


def _run_smoke(tmp_path: Path) -> Path:
    import run_eval

    args = run_eval.__dict__["argparse"].Namespace(
        data=str(ROOT / "fixtures" / "sample_questions.json"),
        smoke=True,
        model=None,
        base_url=None,
        api_key=None,
        limit=None,
        seed=42,
        out=str(tmp_path / "run-smoke"),
    )
    return run_eval.run(args)


class TestSmokePipeline:
    def test_smoke_run_writes_valid_records(self, tmp_path: Path) -> None:
        out_dir = _run_smoke(tmp_path)
        records = [json.loads(line) for line in (out_dir / "record.jsonl").read_text(encoding="utf-8").splitlines()]
        assert len(records) == 3
        for record in records:
            assert validate_record(record) == []
            assert record["status"] == "ok"
            assert record["model"] == "fake-model-smoke"
            assert record["response"].startswith("[smoke]")

    def test_smoke_is_deterministic(self, tmp_path: Path) -> None:
        first = _run_smoke(tmp_path)
        second = _run_smoke(tmp_path / "run-smoke-2")
        records_first = [json.loads(line) for line in (first / "record.jsonl").read_text(encoding="utf-8").splitlines()]
        records_second = [json.loads(line) for line in (second / "record.jsonl").read_text(encoding="utf-8").splitlines()]
        # Timestamps are wall-clock; everything else must be bit-identical.
        for record in records_first + records_second:
            del record["started_at"]
            del record["finished_at"]
        assert records_first == records_second

    def test_score_consumes_smoke_run(self, tmp_path: Path) -> None:
        out_dir = _run_smoke(tmp_path)
        import subprocess

        result = subprocess.run(
            [sys.executable, "score.py", "--run", str(out_dir)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert (out_dir / "score.md").exists()
        assert (out_dir / "score.json").exists()
        scored = json.loads((out_dir / "score.json").read_text(encoding="utf-8"))
        assert scored["records"] == 3
        assert len(scored["samples"]) == 0  # no --answers -> no auto verdicts
