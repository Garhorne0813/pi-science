"""Pi-Science backend configuration."""

import os
from pathlib import Path

# Base directories
BASE_DIR = Path(os.environ.get("PI_SCIENCE_HOME", Path.home() / ".pi-science"))
WORKSPACES_DIR = Path(os.environ.get("PI_SCIENCE_WORKSPACES", Path.home() / "pi-science-workspaces"))

# Sessions stored in the project workspace (like open-science's .opencode/sessions/)
def get_sessions_dir(cwd: str = ".") -> Path:
    """Sessions directory for a given workspace."""
    return (Path(cwd).resolve() / ".pi-science" / "sessions")

# ── pi runtime — auto-detect, like open-science's Tauri sidecar ──
# Two modes:
#   Dev:  pi repo next to pi-science → run from source with tsx (no build)
#   Prod: npm install @earendil-works/pi-coding-agent → dist/cli.js

_runtime_dir = Path(__file__).parent.parent / "runtime" / "pi"
_dev_file = _runtime_dir / ".dev-repo-path"
_prod_cli = _runtime_dir / "cli.js"

if _dev_file.exists():
    # Dev mode: pi runs from source via tsx
    _pi_repo = Path(_dev_file.read_text().strip())
    _tsx = _pi_repo / "node_modules" / ".bin" / "tsx"
    _tsconfig = _pi_repo / "tsconfig.json"
    _src = _pi_repo / "packages" / "coding-agent" / "src" / "cli.ts"
    PI_MODE = "dev"
    PI_CLI_PATH = str(_src)
    PI_TSX_PATH = str(_tsx)
    PI_TSCONFIG_PATH = str(_tsconfig)
elif _prod_cli.exists():
    # Prod mode: built JS from npm
    PI_MODE = "prod"
    PI_CLI_PATH = os.environ.get("PI_CLI_PATH", str(_prod_cli))
    PI_TSX_PATH = None
    PI_TSCONFIG_PATH = None
else:
    # Neither mode set up — user must run fetch-pi.sh or set PI_CLI_PATH
    PI_MODE = "none"
    PI_CLI_PATH = os.environ.get("PI_CLI_PATH", "dist/cli.js")
    PI_TSX_PATH = None
    PI_TSCONFIG_PATH = None

PI_NODE_PATH = os.environ.get("PI_NODE_PATH", "node")
PI_DEFAULT_MODEL = os.environ.get("PI_DEFAULT_MODEL", "anthropic/claude-sonnet-5-20250929")
PI_DEFAULT_THINKING = os.environ.get("PI_DEFAULT_THINKING", "high")

# Server
HOST = os.environ.get("PI_SCIENCE_HOST", "127.0.0.1")
PORT = int(os.environ.get("PI_SCIENCE_PORT", "8787"))
CORS_ORIGINS = os.environ.get("PI_SCIENCE_CORS", "http://localhost:5173,http://127.0.0.1:5173").split(",")

# Skills & extensions bundled with pi-science
SKILLS_DIR = Path(__file__).parent.parent / "skills"
EXTENSIONS_DIR = Path(__file__).parent.parent / "extensions"

# Session limits
SESSION_IDLE_TIMEOUT = int(os.environ.get("PI_SCIENCE_SESSION_IDLE_TIMEOUT", "3600"))


def ensure_dirs():
    """Create required directories and register existing workspaces."""
    WORKSPACES_DIR.mkdir(parents=True, exist_ok=True)
    # Auto-register existing workspace directories for security validation
    try:
        from services.workspace_security import scan_and_register_workspaces
        scan_and_register_workspaces()
    except Exception:
        pass  # Don't block startup if registry fails
