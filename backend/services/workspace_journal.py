"""Shared concurrency primitives for workspace-local durable records."""

from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


_async_locks: dict[str, asyncio.Lock] = {}
_async_guard = threading.Lock()
_sync_locks: dict[str, threading.RLock] = {}
_sync_guard = threading.Lock()


def journal_lock(path: str | Path) -> asyncio.Lock:
    key = str(Path(path).expanduser().resolve())
    with _async_guard:
        return _async_locks.setdefault(key, asyncio.Lock())


@contextmanager
def sync_journal_lock(path: str | Path) -> Iterator[None]:
    key = str(Path(path).expanduser().resolve())
    with _sync_guard:
        lock = _sync_locks.setdefault(key, threading.RLock())
    with lock:
        yield
