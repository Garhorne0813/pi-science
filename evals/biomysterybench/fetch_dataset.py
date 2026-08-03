#!/usr/bin/env python3
"""Fetch the BioMysteryBench-preview dataset into a local cache.

Downloads problems.csv, problems.parquet and data.zip from HuggingFace at the
pinned revision recorded in manifest.json, verifies each file against its
expected sha256, extracts data.zip, and converts problems.csv to problems.json
(no pandas required). Never writes into the repository outside the cache dir.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import json
import shutil
import sys
import zipfile
from pathlib import Path

import requests

from bmb.hashutil import sha256_file

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
DATASET = MANIFEST["dataset"]
REVISION = MANIFEST["revision"]
FILES = MANIFEST["files"]


def resolve_base(cache_dir: str | Path | None) -> Path:
    if cache_dir:
        return Path(cache_dir)
    return ROOT / ".cache"


def fetch(cache_dir: str | Path | None, offline: bool = False, verify: bool = True) -> Path:
    base = resolve_base(cache_dir)
    base.mkdir(parents=True, exist_ok=True)
    manifest_path = base / "fetch-manifest.json"

    if offline:
        if not (base / "problems.json").exists():
            raise SystemExit("--offline requested but cache is incomplete; run without --offline first")
        print(f"[fetch] offline mode; using cache at {base}")
        return base

    base_url = f"https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}"
    observed: dict[str, str] = {}
    for name, meta in FILES.items():
        target = base / name
        print(f"[fetch] downloading {name} ...")
        response = requests.get(f"{base_url}/{name}", timeout=300)
        response.raise_for_status()
        target.write_bytes(response.content)
        digest = sha256_file(target)
        observed[name] = digest
        if verify and digest != meta["sha256"]:
            raise SystemExit(
                f"[fetch] sha256 mismatch for {name}: expected {meta['sha256']} got {digest}; "
                "dataset revision may have changed — refusing to proceed"
            )
        print(f"[fetch] {name} ok ({len(response.content)} bytes, {digest[:12]}…)")

    data_dir = base / "data"
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)
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
    (base / "problems.json").write_text(
        json.dumps({"revision": REVISION, "problems": problems}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    (base / "fetch-manifest.json").write_text(
        json.dumps(
            {
                "dataset": DATASET,
                "revision": REVISION,
                "observed_sha256": observed,
                "problems": len(problems),
                "fetched_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"[fetch] done: {len(problems)} problems, data extracted to {data_dir}")
    return base


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch BioMysteryBench-preview into a local cache")
    parser.add_argument("--cache-dir", default=None, help="cache directory (default: <repo>/evals/biomysterybench/.cache)")
    parser.add_argument("--offline", action="store_true", help="use existing cache without network")
    parser.add_argument("--no-verify", action="store_true", help="skip sha256 verification (not recommended)")
    args = parser.parse_args()
    fetch(args.cache_dir, offline=args.offline, verify=not args.no_verify)


if __name__ == "__main__":
    main()
