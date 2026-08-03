"""Offline tests for fetch_dataset.py (network mocked, cache isolated in tmp_path)."""

from __future__ import annotations

import csv
import io
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import fetch_dataset  # noqa: E402

MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
FILES = MANIFEST["files"]


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def raise_for_status(self) -> None:
        return None


def make_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("sample.txt", "payload")
    return buffer.getvalue()


def make_csv_bytes() -> bytes:
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(["id", "question", "answer_rubric", "allowed_domains", "human_solvable"])
    writer.writerow(["p1", 'What is "X"?', "rubric, with comma", "example.com", "yes"])
    writer.writerow(["p2", "Plain question", "", "", "No"])
    writer.writerow(["p3", "Another", "r2", "", "yes "])
    return stream.getvalue().encode("utf-8")


@pytest.fixture
def fake_downloads(monkeypatch: pytest.MonkeyPatch) -> dict[str, bytes]:
    """Serve synthetic bytes per manifest file; sha256 verification is mocked to pass."""
    contents = {
        "problems.csv": make_csv_bytes(),
        "problems.parquet": b"not-a-real-parquet",
        "data.zip": make_zip_bytes(),
    }
    monkeypatch.setattr(fetch_dataset.requests, "get", lambda url, timeout: FakeResponse(contents[url.rsplit("/", 1)[-1]]))

    real_sha256_file = fetch_dataset.sha256_file

    def fake_sha256_file(path: str | Path) -> str:
        name = Path(path).name
        if name in FILES:
            return FILES[name]["sha256"]
        return real_sha256_file(path)

    monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)
    return contents


class TestFetchSuccess:
    def test_downloads_verifies_extracts_and_converts(self, tmp_path: Path, fake_downloads: dict[str, bytes]) -> None:
        base = fetch_dataset.fetch(tmp_path)

        for name in FILES:
            assert (base / name).exists()
        assert (base / "data" / "sample.txt").read_text(encoding="utf-8") == "payload"

        problems = json.loads((base / "problems.json").read_text(encoding="utf-8"))
        assert problems["revision"] == MANIFEST["revision"]
        assert [p["id"] for p in problems["problems"]] == ["p1", "p2", "p3"]
        # human_solvable parses case-insensitively with whitespace trimmed
        assert [p["human_solvable"] for p in problems["problems"]] == [True, False, True]
        # CSV fields with commas/quotes survive
        assert problems["problems"][0]["answer_rubric"] == "rubric, with comma"
        assert problems["problems"][0]["question"] == 'What is "X"?'
        # absent cells become empty strings
        assert problems["problems"][1]["answer_rubric"] == ""

    def test_fetch_manifest_written(self, tmp_path: Path, fake_downloads: dict[str, bytes]) -> None:
        base = fetch_dataset.fetch(tmp_path)
        manifest = json.loads((base / "fetch-manifest.json").read_text(encoding="utf-8"))
        assert manifest["dataset"] == MANIFEST["dataset"]
        assert manifest["revision"] == MANIFEST["revision"]
        assert manifest["problems"] == 3
        for name, digest in manifest["observed_sha256"].items():
            assert digest == FILES[name]["sha256"]
        assert manifest["fetched_at_utc"]

    def test_fetch_is_repeatable(self, tmp_path: Path, fake_downloads: dict[str, bytes]) -> None:
        base = fetch_dataset.fetch(tmp_path)
        fetch_dataset.fetch(tmp_path)
        assert (base / "data" / "sample.txt").read_text(encoding="utf-8") == "payload"
        problems = json.loads((base / "problems.json").read_text(encoding="utf-8"))
        assert len(problems["problems"]) == 3


class TestFetchHashMismatch:
    def test_mismatch_aborts_without_writing_artifacts(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        contents = {
            "problems.csv": b"id,question\n",
            "problems.parquet": b"bytes",
            "data.zip": make_zip_bytes(),
        }
        monkeypatch.setattr(fetch_dataset.requests, "get", lambda url, timeout: FakeResponse(contents[url.rsplit("/", 1)[-1]]))
        monkeypatch.setattr(fetch_dataset, "sha256_file", lambda path: "0" * 64)

        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path)
        assert "refusing to proceed" in str(exc.value)
        assert not (tmp_path / "problems.json").exists()
        assert not (tmp_path / "fetch-manifest.json").exists()

    def test_no_verify_skips_mismatch(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        contents = {
            "problems.csv": make_csv_bytes(),
            "problems.parquet": b"bytes",
            "data.zip": make_zip_bytes(),
        }
        monkeypatch.setattr(fetch_dataset.requests, "get", lambda url, timeout: FakeResponse(contents[url.rsplit("/", 1)[-1]]))
        monkeypatch.setattr(fetch_dataset, "sha256_file", lambda path: "0" * 64)

        base = fetch_dataset.fetch(tmp_path, verify=False)
        assert (base / "problems.json").exists()


class TestOfflineMode:
    def test_offline_without_cache_exits(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, offline=True)
        assert "--offline requested but cache is incomplete" in str(exc.value)

    def test_offline_with_cache_returns_base(self, tmp_path: Path) -> None:
        (tmp_path / "problems.json").write_text("{}", encoding="utf-8")
        base = fetch_dataset.fetch(tmp_path, offline=True)
        assert base == tmp_path
