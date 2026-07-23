"""Application settings persistence without an API-module dependency."""

from __future__ import annotations

import json
import os
from pathlib import Path

from config import runtime_data_dir
from services.workspace_journal import sync_journal_lock


def config_file() -> Path:
    return runtime_data_dir() / "config.json"


def load_config() -> dict:
    path = config_file()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(data: dict) -> None:
    path = config_file()
    with sync_journal_lock(path):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
        temporary.write_text(json.dumps(data, indent=2))
        os.replace(temporary, path)
