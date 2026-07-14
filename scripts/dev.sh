#!/usr/bin/env bash
# dev.sh — One-command startup for pi-science development
# Usage: bash scripts/dev.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PI_REPO="$(dirname "$PROJECT_DIR")/pi"   # pi repo next to pi-science

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Shutting down...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ── Step 1: Check prerequisites ──
echo -e "${GREEN}==> Checking prerequisites...${NC}"

if ! command -v node &>/dev/null; then
    echo -e "${RED}Error: Node.js is required. Install from https://nodejs.org${NC}"
    exit 1
fi
echo "  Node.js: $(node --version)"

if ! command -v conda &>/dev/null; then
    echo -e "${RED}Error: Conda is required.${NC}"
    exit 1
fi
echo "  Conda: $(conda --version 2>/dev/null)"

# ── Step 2: Fetch/install pi agent runtime ──
echo ""
echo -e "${GREEN}==> Installing pi agent runtime...${NC}"
bash "$SCRIPT_DIR/fetch-pi.sh"
# Resolve the runtime path produced by fetch-pi.sh. In npm mode the script
# creates runtime/pi/cli.js; in local-repo mode it writes .dev-repo-path and
# config.py resolves the source entrypoint itself.
PI_RUNTIME_DIR="$PROJECT_DIR/runtime/pi"
PI_DEV_MARKER="$PI_RUNTIME_DIR/.dev-repo-path"
if [ -n "${PI_CLI_PATH:-}" ]; then
    PI_CLI="$PI_CLI_PATH"
elif [ -f "$PI_DEV_MARKER" ]; then
    PI_REPO_PATH="$(cat "$PI_DEV_MARKER")"
    PI_CLI="$PI_REPO_PATH/packages/coding-agent/src/cli.ts"
else
    PI_CLI="$PI_RUNTIME_DIR/cli.js"
fi
if [ ! -f "$PI_CLI" ]; then
    echo -e "${RED}Error: pi CLI not found at $PI_CLI. Set PI_CLI_PATH to a valid CLI path.${NC}"
    exit 1
fi

# ── Step 3: Install backend dependencies ──
echo ""
echo -e "${GREEN}==> Setting up backend Python environment...${NC}"

# Prefer the historical langgraphv1 Conda environment when it is available,
# but fall back to the active/system Python for a fresh checkout. The old
# unconditional `conda run` left CONDA_PYTHON empty when that environment was
# absent, causing the later `$CONDA_PYTHON -m ...` commands to fail with
# `-m: command not found`.
CONDA_ENV="${CONDA_ENV:-langgraphv1}"
CONDA_PYTHON=""
if command -v conda >/dev/null 2>&1; then
    CONDA_PYTHON="$(conda run -n "$CONDA_ENV" python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
fi
if [ -z "$CONDA_PYTHON" ]; then
    CONDA_PYTHON="${PI_SCIENCE_PYTHON:-$(command -v python3 || command -v python || true)}"
    if [ -z "$CONDA_PYTHON" ]; then
        echo -e "${RED}Error: no usable Python interpreter found. Set PI_SCIENCE_PYTHON manually.${NC}"
        exit 1
    fi
    echo -e "${YELLOW}Warning: Conda env '$CONDA_ENV' is unavailable; using $CONDA_PYTHON.${NC}"
else
    echo "  Conda environment: $CONDA_ENV"
fi

# Keep pip's cache writable in the project as well; some macOS setups have a
# stale root-owned ~/Library/Caches/pip directory.
PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PROJECT_DIR/.cache/pip}"
mkdir -p "$PIP_CACHE_DIR"
export PIP_CACHE_DIR

cd "$PROJECT_DIR/backend"
$CONDA_PYTHON -m pip install fastapi "uvicorn[standard]" pydantic "sse-starlette>=2.0" aiofiles "python-multipart>=0.0.9" --quiet 2>&1 | tail -1
echo "  Backend dependencies installed."
echo "  Python:  $CONDA_PYTHON"
echo "  Package: pi-science $($CONDA_PYTHON -c 'from pi_science import __version__; print(__version__)' 2>/dev/null || echo '0.1.0')"

# ── Step 4: Start backend ──
echo ""
echo -e "${GREEN}==> Starting backend on http://localhost:8787${NC}"

cd "$PROJECT_DIR/backend"

# Set environment variables so backend finds pi
export PI_CLI_PATH="$PI_CLI"
export PI_NODE_PATH="$(which node)"
export PI_SCIENCE_HOME="$PROJECT_DIR/.data"
export PI_SCIENCE_WORKSPACES="$PROJECT_DIR/workspaces"

# Create data dirs
mkdir -p "$PI_SCIENCE_HOME/sessions" "$PI_SCIENCE_WORKSPACES"

# Print config summary
echo "  Python:   $CONDA_PYTHON"
echo "  Node:     $PI_NODE_PATH"
echo "  Pi CLI:   $PI_CLI_PATH"
echo "  Data:     $PI_SCIENCE_HOME"

$CONDA_PYTHON -m uvicorn main:app --host 127.0.0.1 --port 8787 --reload &
BACKEND_PID=$!

# Wait for backend to be ready
echo "  Waiting for backend..."
for i in $(seq 1 20); do
    if curl -s http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
        echo -e "  ${GREEN}Backend ready.${NC}"
        break
    fi
    sleep 0.5
done

# ── Step 5: Start frontend ──
echo ""
echo -e "${GREEN}==> Starting frontend on http://localhost:5173${NC}"

cd "$PROJECT_DIR/frontend"
if [ ! -d "node_modules" ]; then
    echo "  Installing frontend dependencies..."
    npm install --silent 2>&1 | tail -1
fi
npm run dev &
FRONTEND_PID=$!

# ── Done ──
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Pi-Science is running!${NC}"
echo ""
echo "  Frontend:  http://localhost:5173"
echo "  Backend:   http://localhost:8787"
echo "  API docs:  http://localhost:8787/docs"
echo "  Health:    http://localhost:8787/api/health"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop.${NC}"
echo -e "${GREEN}============================================${NC}"

wait
