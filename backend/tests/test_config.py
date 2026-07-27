"""Regression tests for backend process defaults."""

import os
from pathlib import Path
import subprocess
import sys


BACKEND_DIR = Path(__file__).resolve().parents[1]


def load_port(tmp_path: Path, port: str | None = None) -> str:
    env = os.environ.copy()
    env["PI_SCIENCE_HOME"] = str(tmp_path)
    if port is None:
        env.pop("PI_SCIENCE_PORT", None)
    else:
        env["PI_SCIENCE_PORT"] = port
    result = subprocess.run(
        [sys.executable, "-c", "import config; print(config.PORT)"],
        cwd=BACKEND_DIR,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test_scientific_runtime_defaults_to_dedicated_port(tmp_path: Path) -> None:
    assert load_port(tmp_path) == "8788"


def test_scientific_runtime_honors_explicit_port(tmp_path: Path) -> None:
    assert load_port(tmp_path, "9999") == "9999"
