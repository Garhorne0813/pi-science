"""Pi-Science backend configuration."""

import os
from pathlib import Path

# Base directories. Prefer the configured path, but never let a read-only
# home directory prevent the control plane from starting or saving settings.
PROJECT_DIR = Path(__file__).resolve().parent.parent


def runtime_data_dir() -> Path:
    configured = os.environ.get("PI_SCIENCE_HOME")
    candidates = [
        Path(configured).expanduser() if configured else Path.home() / ".pi-science",
        PROJECT_DIR / ".runtime" / "pi-science",
    ]
    for candidate in candidates:
        probe = candidate / f".write-probe-{os.getpid()}"
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe.write_text("", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return candidate
        except OSError:
            try:
                probe.unlink(missing_ok=True)
            except OSError:
                pass
            continue
    # Preserve the configured path for a useful downstream error if every
    # candidate is unavailable.
    return candidates[0]


BASE_DIR = runtime_data_dir()
WORKSPACES_DIR = Path(os.environ.get("PI_SCIENCE_WORKSPACES", Path.home() / "pi-science-workspaces"))

# Server
HOST = os.environ.get("PI_SCIENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PI_SCIENCE_PORT", "8788"))
CORS_ORIGINS = os.environ.get("PI_SCIENCE_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(",")


def ensure_dirs():
    """Create required directories."""
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
