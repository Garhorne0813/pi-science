#!/usr/bin/env python3
"""Fetch the BioMysteryBench dataset into a local cache.

Supports two datasets:

- ``preview`` (default): Anthropic/BioMysteryBench-preview, 5 problems, open.
  Downloads problems.csv, problems.parquet and data.zip at the pinned
  revision recorded in manifest.json, verifies each file against its
  expected sha256, extracts data.zip, and converts problems.csv to
  problems.json.
- ``full``: Anthropic/BioMysteryBench-full, 90 problems, **gated** (requires a
  HuggingFace account that has accepted the dataset terms plus the
  ``HF_TOKEN`` environment variable). Downloads problems.csv (verified) and
  the per-problem data zips (data/hbNNN.zip, listed via the tree API at fetch
  time; observed sha256 recorded in the cache fetch-manifest).

Never writes into the repository outside the cache dir, never writes the
token anywhere, and never uses benchmark content for anything but
evaluation/benchmarking.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path

import requests

from bmb.hashutil import sha256_file

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
DATASETS = {"preview": MANIFEST, "full": MANIFEST["datasets"]["full"]}

HF_TREE_API = "https://huggingface.co/api/datasets/{repo}/tree/{revision}/{path}"
HF_RESOLVE = "https://huggingface.co/datasets/{repo}/resolve/{revision}"


def resolve_base(cache_dir: str | Path | None) -> Path:
    if cache_dir:
        return Path(cache_dir)
    return ROOT / ".cache"


def _auth_headers(dataset: str) -> dict | None:
    """Bearer headers for gated datasets; None for open ones.

    The token is read from the HF_TOKEN environment variable only — it is
    never written to any file or embedded in any artifact.
    """
    if not DATASETS[dataset].get("gated"):
        return None
    token = os.environ.get("HF_TOKEN") or ""
    if not token:
        raise SystemExit(
            f"[fetch] dataset '{dataset}' is gated: set the HF_TOKEN environment "
            "variable to a HuggingFace read token belonging to an account that "
            "has accepted the dataset terms (https://huggingface.co/datasets/"
            f"{DATASETS[dataset]['dataset']})"
        )
    return {"Authorization": f"Bearer {token}"}


def _download(url: str, target: Path, headers: dict | None, verify: bool, expected_sha256: str | None, name: str, retries: int = 3) -> str:
    """Stream a file from HuggingFace with retries.

    A failed attempt is cleaned up (partial file removed) and the file is
    re-downloaded from scratch; backoff is exponential (1s, 2s, 4s)."""
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            label = f"[fetch] downloading {name}" + (f" (attempt {attempt})" if attempt > 1 else "") + " ..."
            print(label)
            if headers:
                response = requests.get(url, timeout=(30, 600), stream=True, headers=headers)
            else:
                response = requests.get(url, timeout=(30, 600), stream=True)
            try:
                response.raise_for_status()
                with open(target, "wb") as handle:
                    for chunk in response.iter_content(chunk_size=1 << 20):
                        if chunk:
                            handle.write(chunk)
            finally:
                response.close()
            digest = sha256_file(target)
            if verify and expected_sha256 and digest != expected_sha256:
                raise SystemExit(
                    f"[fetch] sha256 mismatch for {name}: expected {expected_sha256} got {digest}; "
                    "dataset revision may have changed — refusing to proceed"
                )
            print(f"[fetch] {name} ok ({target.stat().st_size} bytes, {digest[:12]}…)")
            return digest
        except requests.RequestException as exc:
            last_error = exc
            target.unlink(missing_ok=True)
            print(f"[fetch] {name} attempt {attempt} failed: {exc}")
            if attempt < retries:
                time.sleep(2 ** (attempt - 1))
    raise SystemExit(f"[fetch] failed to download {name} after {retries} attempts: {last_error}")


def list_data_zips(cfg: dict, headers: dict | None, limit: int | None) -> list[str]:
    """List per-problem data zips for the full dataset via the tree API.

    Retried like _download (3 attempts, exponential backoff) so transient
    tree API failures do not abort the whole fetch."""
    url = HF_TREE_API.format(repo=cfg["dataset"], revision=cfg["revision"], path="data")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            if headers:
                response = requests.get(url, timeout=300, headers=headers)
            else:
                response = requests.get(url, timeout=300)
            response.raise_for_status()
            entries = response.json()
            zips = sorted(
                entry["path"]
                for entry in entries
                if str(entry.get("path", "")).startswith("data/") and str(entry["path"]).endswith(".zip")
            )
            if limit is not None:
                zips = zips[:limit]
            return zips
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            print(f"[fetch] listing data files attempt {attempt} failed: {exc}")
            if attempt < 3:
                time.sleep(2 ** (attempt - 1))
    raise SystemExit(f"[fetch] failed to list data files after 3 attempts: {last_error}")


def fetch(cache_dir: str | Path | None, offline: bool = False, verify: bool = True, dataset: str = "preview", limit: int | None = None) -> Path:
    if dataset not in DATASETS:
        raise SystemExit(f"[fetch] unknown dataset '{dataset}'; choose from: {', '.join(sorted(DATASETS))}")
    if limit is not None and limit <= 0:
        raise SystemExit(f"[fetch] --limit must be a positive integer, got {limit}")
    cfg = DATASETS[dataset]
    base = resolve_base(cache_dir)
    base.mkdir(parents=True, exist_ok=True)

    if offline:
        if not (base / "problems.json").exists():
            raise SystemExit("--offline requested but cache is incomplete; run without --offline first")
        if dataset == "full":
            data_dir = base / "data"
            if not data_dir.is_dir() or not any(data_dir.iterdir()):
                raise SystemExit("[fetch] --offline requested for 'full' but cached data files are missing; run without --offline first")
            try:
                payload = json.loads((base / "problems.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise SystemExit(f"[fetch] cache problems.json is unreadable: {exc}") from exc
            if payload.get("dataset") != dataset:
                raise SystemExit(
                    f"[fetch] cache problems.json belongs to dataset '{payload.get('dataset')}', not '{dataset}' — "
                    "refusing to mix caches; run without --offline to fetch the correct dataset"
                )
            missing = [p["id"] for p in payload.get("problems", []) if isinstance(p, dict) and not (data_dir / f"{p.get('id')}.zip").exists()]
            if missing:
                shown = ", ".join(missing[:5]) + ("…" if len(missing) > 5 else "")
                print(f"[fetch] warning: offline full cache is missing data zips for {len(missing)} problem(s): {shown}")
        print(f"[fetch] offline mode; using cache at {base}")
        return base

    headers = _auth_headers(dataset)
    base_url = HF_RESOLVE.format(repo=cfg["dataset"], revision=cfg["revision"])
    observed: dict[str, str] = {}

    # Static files pinned in the manifest (preview: problems.csv + problems.parquet + data.zip; full: problems.csv).
    for name, meta in cfg["files"].items():
        target = base / name
        digest = _download(f"{base_url}/{name}", target, headers, verify, meta["sha256"], name)
        observed[name] = digest

    # Per-problem data files.
    data_dir = base / "data"
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)
    if dataset == "full":
        zips = list_data_zips(cfg, headers, limit)
        for name in zips:
            target = data_dir / Path(name).name
            # Per-problem zips have no pinned hash (the dataset publishes none):
            # integrity rests on TLS plus the observed sha256 recorded in
            # fetch-manifest.json below; --no-verify only affects pinned files.
            digest = _download(f"{base_url}/{name}", target, headers, verify=False, expected_sha256=None, name=name)
            observed[name] = digest
    else:
        with zipfile.ZipFile(base / "data.zip") as archive:
            archive.extractall(data_dir)

    problems: list[dict] = []
    with open(base / "problems.csv", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            problems.append(
                {
                    "id": row["id"],
                    "question": row["question"],
                    "answer_rubric": row.get("answer_rubric", ""),
                    "allowed_domains": row.get("allowed_domains", ""),
                    "human_solvable": (row.get("human_solvable", "no").strip().lower() == "yes"),
                }
            )
    if limit is not None:
        problems = problems[:limit]
    (base / "problems.json").write_text(
        json.dumps({"dataset": dataset, "revision": cfg["revision"], "problems": problems}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Cross-check: every kept problem should have its data zip cached (full only;
    # preview extracts arbitrary files, not per-problem zips).
    if dataset == "full":
        missing = [p["id"] for p in problems if not (data_dir / f"{p['id']}.zip").exists()]
        if missing:
            shown = ", ".join(missing[:5]) + ("…" if len(missing) > 5 else "")
            print(f"[fetch] warning: no cached data zip for {len(missing)} problem(s): {shown}")

    (base / "fetch-manifest.json").write_text(
        json.dumps(
            {
                "dataset": cfg["dataset"],
                "dataset_key": dataset,
                "revision": cfg["revision"],
                "observed_sha256": observed,
                "problems": len(problems),
                "data_file_count": sum(1 for key in observed if key.startswith("data/")),
                "fetched_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[fetch] done: {len(problems)} problems, data files in {data_dir}")
    return base


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch BioMysteryBench (preview or full) into a local cache")
    parser.add_argument("--cache-dir", default=None, help="cache directory (default: <repo>/evals/biomysterybench/.cache)")
    parser.add_argument("--offline", action="store_true", help="use existing cache without network")
    parser.add_argument("--no-verify", action="store_true", help="skip sha256 verification (not recommended)")
    parser.add_argument("--dataset", default="preview", choices=sorted(DATASETS), help="which dataset to fetch (full is gated, requires HF_TOKEN)")
    parser.add_argument("--limit", type=int, default=None, help="only fetch data for the first N problems (full only; debugging)")
    args = parser.parse_args()
    fetch(args.cache_dir, offline=args.offline, verify=not args.no_verify, dataset=args.dataset, limit=args.limit)


if __name__ == "__main__":
    main()
