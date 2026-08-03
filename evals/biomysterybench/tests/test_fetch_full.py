"""Offline tests for the gated 'full' dataset path in fetch_dataset.py.

All network access is mocked; the HF_TOKEN flows through the mocked request
headers only and is asserted, never written to disk.
"""

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

FULL = fetch_dataset.MANIFEST["datasets"]["full"]
TOKEN = "hf-test-token"


def make_csv_bytes(problem_ids=("hb001", "hb002", "hb003")) -> bytes:
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(["id", "question", "answer_rubric", "allowed_domains", "human_solvable"])
    for pid in problem_ids:
        writer.writerow([pid, f"Question {pid}?", "rubric", "", "yes"])
    return stream.getvalue().encode("utf-8")


def make_tree_payload(count: int = 3) -> bytes:
    entries = [{"path": f"data/hb{i:03d}.zip", "size": 10} for i in range(1, count + 1)]
    return json.dumps(entries).encode("utf-8")


def make_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("sample.txt", "payload")
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int = 1 << 20):
        for index in range(0, len(self.content), chunk_size):
            yield self.content[index : index + chunk_size]

    def close(self) -> None:
        return None

    def json(self):
        return json.loads(self.content.decode("utf-8"))


@pytest.fixture
def full_downloads(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Mock tree + resolve for the full dataset, capturing auth headers and URLs."""
    seen = {"resolve_headers": None, "tree_headers": None, "urls": []}
    contents = {"problems.csv": make_csv_bytes()}

    def fake_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
        if "/tree/" in url:
            seen["tree_headers"] = headers
            return FakeResponse(make_tree_payload(3))
        seen["resolve_headers"] = headers
        seen["urls"].append(url)
        name = url.rsplit("/", 1)[-1]
        return FakeResponse(contents.get(name, b"zip-bytes"))

    monkeypatch.setattr(fetch_dataset.requests, "get", fake_get)
    monkeypatch.setenv("HF_TOKEN", TOKEN)

    real_sha256_file = fetch_dataset.sha256_file

    def fake_sha256_file(path: str | Path) -> str:
        if Path(path).name == "problems.csv":
            return FULL["files"]["problems.csv"]["sha256"]
        return real_sha256_file(path)

    monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)
    return seen


class TestFullAuth:
    def test_full_without_token_exits(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("HF_TOKEN", raising=False)
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, dataset="full")
        assert "HF_TOKEN" in str(exc.value)

    def test_full_sends_bearer_token(self, tmp_path: Path, full_downloads: dict) -> None:
        fetch_dataset.fetch(tmp_path, dataset="full")
        assert full_downloads["resolve_headers"] == {"Authorization": "Bearer hf-test-token"}
        assert full_downloads["tree_headers"] == {"Authorization": "Bearer hf-test-token"}


class TestFullFetch:
    def test_downloads_csv_zips_and_writes_artifacts(self, tmp_path: Path, full_downloads: dict) -> None:
        base = fetch_dataset.fetch(tmp_path, dataset="full")

        assert (base / "problems.csv").exists()
        # per-problem zips land in data/ without extraction
        assert sorted(p.name for p in (base / "data").glob("*.zip")) == ["hb001.zip", "hb002.zip", "hb003.zip"]

        problems = json.loads((base / "problems.json").read_text(encoding="utf-8"))
        assert problems["dataset"] == "full"
        assert problems["revision"] == FULL["revision"]
        assert [p["id"] for p in problems["problems"]] == ["hb001", "hb002", "hb003"]

        manifest = json.loads((base / "fetch-manifest.json").read_text(encoding="utf-8"))
        assert manifest["dataset_key"] == "full"
        assert manifest["dataset"] == "Anthropic/BioMysteryBench-full"
        assert manifest["problems"] == 3
        assert manifest["data_file_count"] == 3
        assert manifest["observed_sha256"]["data/hb001.zip"]
        assert manifest["observed_sha256"]["problems.csv"] == FULL["files"]["problems.csv"]["sha256"]

    def test_limit_downloads_only_first_n(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        contents = {"problems.csv": make_csv_bytes([f"hb{i:03d}" for i in range(1, 91)])}

        def fake_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
            if "/tree/" in url:
                return FakeResponse(make_tree_payload(90))
            name = url.rsplit("/", 1)[-1]
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", fake_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)

        base = fetch_dataset.fetch(tmp_path, dataset="full", limit=2)
        assert sorted(p.name for p in (base / "data").glob("*.zip")) == ["hb001.zip", "hb002.zip"]
        problems = json.loads((base / "problems.json").read_text(encoding="utf-8"))
        assert len(problems["problems"]) == 2

    def test_preview_default_is_unaffected(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        # fetch() without a dataset argument still means preview; the gated code path is not entered.
        import inspect

        signature = inspect.signature(fetch_dataset.fetch)
        assert signature.parameters["dataset"].default == "preview"
        # Preview fetch succeeds without HF_TOKEN and never hits the tree API.
        monkeypatch.delenv("HF_TOKEN", raising=False)
        contents = {
            "problems.csv": make_csv_bytes(),
            "problems.parquet": b"not-a-real-parquet",
            "data.zip": make_zip_bytes(),
        }
        monkeypatch.setattr(
            fetch_dataset.requests, "get", lambda url, timeout, stream=False: FakeResponse(contents[url.rsplit("/", 1)[-1]])
        )
        monkeypatch.setattr(
            fetch_dataset, "sha256_file", lambda path: fetch_dataset.MANIFEST["files"][Path(path).name]["sha256"]
        )
        base = fetch_dataset.fetch(tmp_path)
        assert (base / "problems.json").exists()
        manifest = json.loads((base / "fetch-manifest.json").read_text(encoding="utf-8"))
        assert manifest["dataset_key"] == "preview"


class TestOfflineFull:
    def test_offline_full_without_data_exits(self, tmp_path: Path) -> None:
        (tmp_path / "problems.json").write_text(json.dumps({"dataset": "full"}), encoding="utf-8")
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, offline=True, dataset="full")
        assert "cached data files are missing" in str(exc.value)

    def test_offline_full_with_data_returns_base(self, tmp_path: Path) -> None:
        (tmp_path / "problems.json").write_text(json.dumps({"dataset": "full", "problems": [{"id": "hb001"}]}), encoding="utf-8")
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        (data_dir / "hb001.zip").write_bytes(b"x")
        base = fetch_dataset.fetch(tmp_path, offline=True, dataset="full")
        assert base == tmp_path

    def test_offline_full_wrong_dataset_tag_exits(self, tmp_path: Path) -> None:
        """A preview cache must not silently serve as a 'full' cache."""
        (tmp_path / "problems.json").write_text(json.dumps({"dataset": "preview"}), encoding="utf-8")
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        (data_dir / "hb001.zip").write_bytes(b"x")
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, offline=True, dataset="full")
        assert "refusing to mix caches" in str(exc.value)

    def test_offline_full_warns_on_missing_zips(self, tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
        (tmp_path / "problems.json").write_text(
            json.dumps({"dataset": "full", "problems": [{"id": "hb001"}, {"id": "hb002"}]}), encoding="utf-8"
        )
        data_dir = tmp_path / "data"
        data_dir.mkdir()
        (data_dir / "hb001.zip").write_bytes(b"x")
        fetch_dataset.fetch(tmp_path, offline=True, dataset="full")
        captured = capsys.readouterr()
        assert "warning: offline full cache is missing data zips for 1 problem(s): hb002" in captured.out

    def test_unknown_dataset_exits(self, tmp_path: Path) -> None:
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, dataset="nope")
        assert "unknown dataset" in str(exc.value)


class TestLimitValidation:
    @pytest.mark.parametrize("bad_limit", [0, -1, -10])
    def test_non_positive_limit_exits(self, tmp_path: Path, bad_limit: int) -> None:
        with pytest.raises(SystemExit) as exc:
            fetch_dataset.fetch(tmp_path, dataset="full", limit=bad_limit)
        assert "--limit must be a positive integer" in str(exc.value)

    def test_positive_limit_allowed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """A positive limit still downloads and slices normally."""
        contents = {"problems.csv": make_csv_bytes()}

        def fake_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
            if "/tree/" in url:
                return FakeResponse(make_tree_payload(3))
            name = url.rsplit("/", 1)[-1]
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", fake_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)
        base = fetch_dataset.fetch(tmp_path, dataset="full", limit=1)
        assert sorted(p.name for p in (base / "data").glob("*.zip")) == ["hb001.zip"]


class TestCoverageWarnings:
    def test_fetch_warns_when_csv_ids_missing_zips(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
        """problems.csv lists 3 ids but the tree only has 2 zips -> warning, not failure."""
        contents = {"problems.csv": make_csv_bytes()}

        def fake_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
            if "/tree/" in url:
                return FakeResponse(make_tree_payload(2))
            name = url.rsplit("/", 1)[-1]
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", fake_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)
        fetch_dataset.fetch(tmp_path, dataset="full")
        captured = capsys.readouterr()
        assert "warning: no cached data zip for 1 problem(s): hb003" in captured.out

    def test_fetch_has_no_warning_when_covered(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
        contents = {"problems.csv": make_csv_bytes()}

        def fake_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
            if "/tree/" in url:
                return FakeResponse(make_tree_payload(3))
            name = url.rsplit("/", 1)[-1]
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", fake_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)
        fetch_dataset.fetch(tmp_path, dataset="full")
        captured = capsys.readouterr()
        assert "warning: no cached data zip" not in captured.out


class TestListDataZipsRetry:
    def test_tree_retries_after_transient_failure(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import requests

        calls = {"count": 0}

        def flaky_get(url: str, timeout: int, headers: dict | None = None, stream: bool = False):
            calls["count"] += 1
            if "/tree/" in url:
                if calls["count"] == 1:
                    raise requests.exceptions.ChunkedEncodingError("tree hiccup")
                return FakeResponse(make_tree_payload(1))
            name = url.rsplit("/", 1)[-1]
            contents = {"problems.csv": make_csv_bytes(["hb001"])}
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", flaky_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)

        base = fetch_dataset.fetch(tmp_path, dataset="full", limit=1)
        assert calls["count"] >= 2
        assert (base / "data" / "hb001.zip").exists()
        assert (base / "problems.json").exists()


class TestRetry:
    def test_download_retries_after_chunk_error(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        import requests

        calls = {"count": 0}

        def flaky_get(url: str, timeout, headers: dict | None = None, stream: bool = False):
            calls["count"] += 1
            if calls["count"] == 1:
                raise requests.exceptions.ChunkedEncodingError("Connection broken")
            if "/tree/" in url:
                return FakeResponse(make_tree_payload(1))
            name = url.rsplit("/", 1)[-1]
            contents = {"problems.csv": make_csv_bytes(["hb001"])}
            return FakeResponse(contents.get(name, b"zip-bytes"))

        monkeypatch.setattr(fetch_dataset.requests, "get", flaky_get)
        monkeypatch.setenv("HF_TOKEN", TOKEN)
        real_sha256_file = fetch_dataset.sha256_file

        def fake_sha256_file(path: str | Path) -> str:
            if Path(path).name == "problems.csv":
                return FULL["files"]["problems.csv"]["sha256"]
            return real_sha256_file(path)

        monkeypatch.setattr(fetch_dataset, "sha256_file", fake_sha256_file)

        base = fetch_dataset.fetch(tmp_path, dataset="full", limit=1)
        assert calls["count"] >= 2  # first attempt failed, retry succeeded
        assert (base / "data" / "hb001.zip").exists()
        assert (base / "problems.json").exists()
