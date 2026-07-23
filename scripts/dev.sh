#!/usr/bin/env bash
# dev.sh — One-command startup for pi-science development
# Usage: bash scripts/dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_PID=""
CONTROL_PLANE_PID=""
FRONTEND_PID=""
FRONTEND_REUSED=false
CONTROL_PLANE_PORT="${PI_SCIENCE_CONTROL_PLANE_PORT:-8787}"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo ""
    echo -e "${YELLOW}==> Shutting down...${NC}"
    if [ -n "$CONTROL_PLANE_PID" ]; then kill "$CONTROL_PLANE_PID" 2>/dev/null || true; fi
    if [ -n "$BACKEND_PID" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
    if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
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
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo -e "${RED}Error: Node.js 22 or newer is required (found $(node --version)).${NC}"
    exit 1
fi

if ! command -v pnpm &>/dev/null; then
    echo -e "${RED}Error: pnpm is required. Enable it with: corepack enable pnpm${NC}"
    exit 1
fi
echo "  pnpm:   $(pnpm --version)"

if command -v conda &>/dev/null; then
    # Some Conda installations print a requests/urllib3 compatibility warning
    # before the version line. Keep prerequisite output actionable by retaining
    # only the actual version and treating a noisy probe as "available".
    CONDA_VERSION="$(conda --version 2>&1 | sed -n 's/^conda[[:space:]]*//p' | head -n 1 || true)"
    echo "  Conda: ${CONDA_VERSION:-available}"
else
    echo "  Conda: not installed (optional; using system Python)"
fi

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

# ── Step 3: Install JavaScript workspace dependencies ──
echo ""
echo -e "${GREEN}==> Installing JavaScript workspace dependencies...${NC}"
cd "$PROJECT_DIR"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$PROJECT_DIR/.cache/pnpm-store}"
mkdir -p "$PNPM_STORE_DIR"
pnpm --config.store-dir="$PNPM_STORE_DIR" install --frozen-lockfile

# ── Step 4: Install backend dependencies ──
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
    if command -v uv >/dev/null 2>&1; then
        echo "  Using uv-managed backend environment."
        UV_CACHE_DIR="${UV_CACHE_DIR:-$PROJECT_DIR/.cache/uv}"
        mkdir -p "$UV_CACHE_DIR"
        export UV_CACHE_DIR
        (cd "$PROJECT_DIR/backend" && uv sync --extra dev)
        CONDA_PYTHON="$PROJECT_DIR/backend/.venv/bin/python"
    else
        CONDA_PYTHON="${PI_SCIENCE_PYTHON:-$(command -v python3 || command -v python || true)}"
        if [ -z "$CONDA_PYTHON" ]; then
            echo -e "${RED}Error: no usable Python interpreter found. Set PI_SCIENCE_PYTHON manually.${NC}"
            exit 1
        fi
        echo -e "${YELLOW}Warning: Conda env '$CONDA_ENV' is unavailable; using $CONDA_PYTHON.${NC}"
    fi
else
    echo "  Conda environment: $CONDA_ENV"
fi

if ! "$CONDA_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
    echo -e "${RED}Error: Python 3.11 or newer is required (found $("$CONDA_PYTHON" --version 2>&1)).${NC}"
    exit 1
fi

port_is_available() {
    "$CONDA_PYTHON" -c 'import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "$1" >/dev/null 2>&1
}

# Return success when a listening process on the given port belongs to this
# checkout's frontend. A previous `dev.sh` may have left Vite running after
# the shell was interrupted; that process is safe to reuse.
project_frontend_is_running() {
    local pid cwd
    command -v lsof >/dev/null 2>&1 || return 1
    while read -r pid; do
        [ -n "$pid" ] || continue
        cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
        if [ "$cwd" = "$PROJECT_DIR/frontend" ]; then
            return 0
        fi
    done < <(lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null | sort -u)
    return 1
}

# Keep pip's cache writable in the project as well; some macOS setups have a
# stale root-owned ~/Library/Caches/pip directory.
PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PROJECT_DIR/.cache/pip}"
mkdir -p "$PIP_CACHE_DIR"
export PIP_CACHE_DIR

cd "$PROJECT_DIR/backend"
if [ ! -x "$PROJECT_DIR/backend/.venv/bin/python" ]; then
    "$CONDA_PYTHON" -m pip install -e "$PROJECT_DIR/backend[dev]" --quiet 2>&1 | tail -1
fi
echo "  Backend dependencies installed."
echo "  Python:  $CONDA_PYTHON"
echo "  Package: pi-science $("$CONDA_PYTHON" -c 'from pi_science import __version__; print(__version__)' 2>/dev/null || echo '0.1.0')"

# ── Step 5: Start Python scientific runtime ──
echo ""
SCIENTIFIC_RUNTIME_PORT="${PI_SCIENCE_RUNTIME_PORT:-8788}"
echo -e "${GREEN}==> Starting Python scientific runtime on http://localhost:${SCIENTIFIC_RUNTIME_PORT}${NC}"

if ! port_is_available "$SCIENTIFIC_RUNTIME_PORT"; then
    echo -e "${RED}Error: port ${SCIENTIFIC_RUNTIME_PORT} is already in use. Stop the existing scientific runtime first.${NC}"
    exit 1
fi

cd "$PROJECT_DIR/backend"

# Set environment variables so backend finds pi
export PI_CLI_PATH="$PI_CLI"
export PI_NODE_PATH="$(which node)"
# Use the standard user-level data & workspace locations so dev mode
# shares the same config, sessions, and workspaces as the installed app.
if [ -z "${PI_SCIENCE_HOME:-}" ]; then
    PI_DATA_PROBE="$HOME/.pi-science/.write-probe-$$"
    if mkdir -p "$HOME/.pi-science" 2>/dev/null && : > "$PI_DATA_PROBE" 2>/dev/null; then
        rm -f "$PI_DATA_PROBE" 2>/dev/null || true
        export PI_SCIENCE_HOME="$HOME/.pi-science"
    else
        rm -f "$PI_DATA_PROBE" 2>/dev/null || true
        export PI_SCIENCE_HOME="$PROJECT_DIR/.runtime/pi-science"
        echo -e "  ${YELLOW}Home data directory is not writable; using project-local runtime data.${NC}"
    fi
fi
export PI_SCIENCE_WORKSPACES="${PI_SCIENCE_WORKSPACES:-$HOME/pi-science-workspaces}"
export PI_SCIENCE_INTERNAL_TOKEN="${PI_SCIENCE_INTERNAL_TOKEN:-$(openssl rand -hex 32 2>/dev/null || date +%s)}"
export PI_SCIENCE_REQUIRE_INTERNAL_TOKEN="${PI_SCIENCE_REQUIRE_INTERNAL_TOKEN:-1}"

mkdir -p "$PI_SCIENCE_HOME/sessions" "$PI_SCIENCE_WORKSPACES"

# Print config summary
echo "  Python:   $CONDA_PYTHON"
echo "  Node:     $PI_NODE_PATH"
echo "  Pi CLI:   $PI_CLI_PATH"
echo "  Data:     $PI_SCIENCE_HOME"

PI_SCIENCE_PORT="$SCIENTIFIC_RUNTIME_PORT" "$CONDA_PYTHON" -m uvicorn main:app --host 127.0.0.1 --port "$SCIENTIFIC_RUNTIME_PORT" --reload &
BACKEND_PID=$!

# Wait for scientific runtime to be ready
echo "  Waiting for scientific runtime..."
BACKEND_READY=false
for _ in $(seq 1 20); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then break; fi
    if curl --fail --silent "http://127.0.0.1:${SCIENTIFIC_RUNTIME_PORT}/api/health" >/dev/null 2>&1; then
        echo -e "  ${GREEN}Scientific runtime ready.${NC}"
        BACKEND_READY=true
        break
    fi
    sleep 0.5
done
if [ "$BACKEND_READY" != true ]; then
    echo -e "${RED}Error: scientific runtime did not become ready on port ${SCIENTIFIC_RUNTIME_PORT}.${NC}"
    exit 1
fi

# ── Step 6: Start Node control plane ──
echo ""
echo -e "${GREEN}==> Starting Node control plane on http://localhost:${CONTROL_PLANE_PORT}${NC}"

if ! port_is_available "$CONTROL_PLANE_PORT"; then
    echo -e "${RED}Error: port ${CONTROL_PLANE_PORT} is already in use. Stop the existing control plane first.${NC}"
    exit 1
fi

cd "$PROJECT_DIR"
export PI_SCIENCE_PYTHON_ORIGIN="http://127.0.0.1:${SCIENTIFIC_RUNTIME_PORT}"
export PI_SCIENCE_BACKEND_URL="${PI_SCIENCE_BACKEND_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT}}"
# Conversation ownership is Node-native in the migrated control plane. Python
# remains the scientific runtime and compatibility target for non-conversation
# routes.
export PI_SCIENCE_NODE_SESSIONS="${PI_SCIENCE_NODE_SESSIONS:-1}"
export PI_SCIENCE_NODE_SSE="${PI_SCIENCE_NODE_SSE:-1}"
export PI_SCIENCE_NODE_PI_MANAGER="${PI_SCIENCE_NODE_PI_MANAGER:-1}"
mkdir -p "$PNPM_STORE_DIR"
PI_SCIENCE_PORT="$CONTROL_PLANE_PORT" pnpm --config.store-dir="$PNPM_STORE_DIR" --filter @pi-science/server dev &
CONTROL_PLANE_PID=$!

echo "  Waiting for control plane..."
CONTROL_PLANE_READY=false
for _ in $(seq 1 30); do
    if ! kill -0 "$CONTROL_PLANE_PID" 2>/dev/null; then break; fi
    if curl --fail --silent "http://127.0.0.1:${CONTROL_PLANE_PORT}/api/health" >/dev/null 2>&1; then
        echo -e "  ${GREEN}Control plane ready.${NC}"
        CONTROL_PLANE_READY=true
        break
    fi
    sleep 0.5
done
if [ "$CONTROL_PLANE_READY" != true ]; then
    echo -e "${RED}Error: control plane did not become ready on port ${CONTROL_PLANE_PORT}.${NC}"
    exit 1
fi

# ── Step 7: Start frontend ──
echo ""
echo -e "${GREEN}==> Starting frontend on http://localhost:5173${NC}"

if ! port_is_available 5173; then
    if project_frontend_is_running; then
        FRONTEND_REUSED=true
        echo -e "  ${YELLOW}Reusing existing Pi-Science frontend on port 5173.${NC}"
    else
        echo -e "${RED}Error: port 5173 is already in use by another process. Stop it before starting Pi-Science.${NC}"
        exit 1
    fi
fi

if [ "$FRONTEND_REUSED" != true ]; then
    cd "$PROJECT_DIR/frontend"
    NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$PROJECT_DIR/.cache/npm}"
    mkdir -p "$NPM_CONFIG_CACHE"
    export NPM_CONFIG_CACHE
    echo "  Checking frontend dependencies..."
    npm install --silent 2>&1 | tail -1
    npm run dev -- --host 127.0.0.1 --port 5173 --strictPort &
    FRONTEND_PID=$!

    echo "  Waiting for frontend..."
    FRONTEND_READY=false
    for _ in $(seq 1 30); do
        if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then break; fi
        if curl --fail --silent http://127.0.0.1:5173 >/dev/null 2>&1; then
            echo -e "  ${GREEN}Frontend ready.${NC}"
            FRONTEND_READY=true
            break
        fi
        sleep 0.5
    done
    if [ "$FRONTEND_READY" != true ]; then
        echo -e "${RED}Error: frontend did not become ready on port 5173.${NC}"
        exit 1
    fi
fi

# ── Done ──
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Pi-Science is running!${NC}"
echo ""
echo "  Frontend:  http://localhost:5173"
echo "  Node control plane: http://localhost:${CONTROL_PLANE_PORT}"
echo "  Python runtime:     http://localhost:${SCIENTIFIC_RUNTIME_PORT} (internal)"
echo "  API docs:  http://localhost:${CONTROL_PLANE_PORT}/docs"
echo "  Health:    http://localhost:${CONTROL_PLANE_PORT}/api/health"
echo ""
echo -e "  ${YELLOW}Press Ctrl+C to stop.${NC}"
echo -e "${GREEN}============================================${NC}"

wait
