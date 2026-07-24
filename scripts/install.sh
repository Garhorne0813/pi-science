#!/usr/bin/env bash
# install.sh — install project dependencies and the Pi runtime.
# Usage: bash scripts/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_DIR/runtime/pi"
INSTALL_STATE_DIR="$PROJECT_DIR/.runtime/pi-science"
INSTALL_STATE_FILE="$INSTALL_STATE_DIR/install.env"

echo "==> Checking installation prerequisites..."
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (22 or newer)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js 22 or newer is required (found $(node --version))." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required. Enable it with: corepack enable pnpm" >&2
  exit 1
fi

echo "  Node.js: $(node --version)"
echo "  pnpm:   $(pnpm --version)"

if [ -n "${PI_CLI_PATH:-}" ]; then
  PI_CLI="$PI_CLI_PATH"
  [ -f "$PI_CLI" ] || { echo "Error: PI_CLI_PATH does not point to a file: $PI_CLI" >&2; exit 1; }
else
  echo "==> Installing Pi agent runtime..."
  bash "$SCRIPT_DIR/fetch-pi.sh"
  PI_DEV_MARKER="$RUNTIME_DIR/.dev-repo-path"
  if [ -f "$PI_DEV_MARKER" ]; then
    PI_REPO_PATH="$(cat "$PI_DEV_MARKER")"
    PI_CLI="$PI_REPO_PATH/packages/coding-agent/src/cli.ts"
  else
    PI_CLI="$RUNTIME_DIR/cli.js"
  fi
fi

echo "==> Installing JavaScript workspace dependencies..."
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$PROJECT_DIR/.cache/pnpm-store}"
mkdir -p "$PNPM_STORE_DIR"
cd "$PROJECT_DIR"
pnpm --config.store-dir="$PNPM_STORE_DIR" install --frozen-lockfile

echo "==> Installing backend dependencies..."
CONDA_ENV="${CONDA_ENV:-langgraphv1}"
CONDA_PYTHON=""
if command -v conda >/dev/null 2>&1; then
  CONDA_PYTHON="$(conda run -n "$CONDA_ENV" python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
fi

if [ -z "$CONDA_PYTHON" ] && command -v uv >/dev/null 2>&1; then
  UV_CACHE_DIR="${UV_CACHE_DIR:-$PROJECT_DIR/.cache/uv}"
  mkdir -p "$UV_CACHE_DIR"
  export UV_CACHE_DIR
  (cd "$PROJECT_DIR/backend" && uv sync --extra dev)
  CONDA_PYTHON="$PROJECT_DIR/backend/.venv/bin/python"
elif [ -z "$CONDA_PYTHON" ]; then
  CONDA_PYTHON="${PI_SCIENCE_PYTHON:-$(command -v python3 || command -v python || true)}"
  [ -n "$CONDA_PYTHON" ] || { echo "Error: no usable Python interpreter found." >&2; exit 1; }
  PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PROJECT_DIR/.cache/pip}"
  mkdir -p "$PIP_CACHE_DIR"
  export PIP_CACHE_DIR
  "$CONDA_PYTHON" -m pip install -e "$PROJECT_DIR/backend[dev]"
elif [ ! -x "$PROJECT_DIR/backend/.venv/bin/python" ]; then
  PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PROJECT_DIR/.cache/pip}"
  mkdir -p "$PIP_CACHE_DIR"
  export PIP_CACHE_DIR
  "$CONDA_PYTHON" -m pip install -e "$PROJECT_DIR/backend[dev]"
fi

if ! "$CONDA_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  echo "Error: Python 3.11 or newer is required." >&2
  exit 1
fi

mkdir -p "$INSTALL_STATE_DIR"
printf 'PI_SCIENCE_INSTALL_PYTHON=%q\nPI_SCIENCE_INSTALL_PI_CLI=%q\n' "$CONDA_PYTHON" "$PI_CLI" > "$INSTALL_STATE_FILE"
echo "==> Installation complete."
echo "  Python: $CONDA_PYTHON"
echo "  Pi CLI: $PI_CLI"
