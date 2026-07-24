#!/usr/bin/env bash
# start.sh — start already-installed Pi-Science services.
# Usage: bash scripts/start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_STATE_FILE="$PROJECT_DIR/.runtime/pi-science/install.env"
if [ -f "$INSTALL_STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$INSTALL_STATE_FILE"
fi

CONDA_PYTHON="${PI_SCIENCE_PYTHON:-${PI_SCIENCE_INSTALL_PYTHON:-}}"
PI_CLI="${PI_CLI_PATH:-${PI_SCIENCE_INSTALL_PI_CLI:-}}"
[ -x "$CONDA_PYTHON" ] || { echo "Error: Python environment is not installed. Run: bash scripts/install.sh" >&2; exit 1; }
[ -f "$PI_CLI" ] || { echo "Error: Pi runtime is not installed. Run: bash scripts/install.sh" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm is required." >&2; exit 1; }

BACKEND_PID=""
CONTROL_PLANE_PID=""
FRONTEND_PID=""
FRONTEND_REUSED=false
CONTROL_PLANE_PORT="${PI_SCIENCE_CONTROL_PLANE_PORT:-8787}"
SCIENTIFIC_RUNTIME_PORT="${PI_SCIENCE_RUNTIME_PORT:-8788}"
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$PROJECT_DIR/.cache/pnpm-store}"
PIP_CACHE_DIR="${PIP_CACHE_DIR:-$PROJECT_DIR/.cache/pip}"

cleanup() {
  echo ""
  echo "==> Shutting down..."
  [ -z "$CONTROL_PLANE_PID" ] || kill "$CONTROL_PLANE_PID" 2>/dev/null || true
  [ -z "$BACKEND_PID" ] || kill "$BACKEND_PID" 2>/dev/null || true
  [ -z "$FRONTEND_PID" ] || kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

port_is_available() {
  "$CONDA_PYTHON" -c 'import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "$1" >/dev/null 2>&1
}

project_frontend_is_running() {
  local pid cwd
  command -v lsof >/dev/null 2>&1 || return 1
  while read -r pid; do
    [ -n "$pid" ] || continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    [ "$cwd" = "$PROJECT_DIR/frontend" ] && return 0
  done < <(lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null | sort -u)
  return 1
}

export PI_CLI_PATH="$PI_CLI"
export PI_NODE_PATH="$(command -v node)"
export PIP_CACHE_DIR
export PI_SCIENCE_HOME="${PI_SCIENCE_HOME:-$HOME/.pi-science}"
export PI_SCIENCE_WORKSPACES="${PI_SCIENCE_WORKSPACES:-$HOME/pi-science-workspaces}"
export PI_SCIENCE_INTERNAL_TOKEN="${PI_SCIENCE_INTERNAL_TOKEN:-$(openssl rand -hex 32 2>/dev/null || date +%s)}"
export PI_SCIENCE_REQUIRE_INTERNAL_TOKEN="${PI_SCIENCE_REQUIRE_INTERNAL_TOKEN:-1}"
mkdir -p "$PI_SCIENCE_HOME/sessions" "$PI_SCIENCE_WORKSPACES" "$PNPM_STORE_DIR"

if ! port_is_available "$SCIENTIFIC_RUNTIME_PORT"; then
  echo "Error: port $SCIENTIFIC_RUNTIME_PORT is already in use." >&2
  exit 1
fi
if ! port_is_available "$CONTROL_PLANE_PORT"; then
  echo "Error: port $CONTROL_PLANE_PORT is already in use." >&2
  exit 1
fi

echo "==> Starting Python scientific runtime on http://127.0.0.1:$SCIENTIFIC_RUNTIME_PORT"
cd "$PROJECT_DIR/backend"
PI_SCIENCE_PORT="$SCIENTIFIC_RUNTIME_PORT" "$CONDA_PYTHON" -m uvicorn main:app --host 127.0.0.1 --port "$SCIENTIFIC_RUNTIME_PORT" --reload &
BACKEND_PID=$!

echo "  Waiting for scientific runtime..."
for _ in $(seq 1 20); do
  kill -0 "$BACKEND_PID" 2>/dev/null || break
  curl --fail --silent "http://127.0.0.1:${SCIENTIFIC_RUNTIME_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl --fail --silent "http://127.0.0.1:${SCIENTIFIC_RUNTIME_PORT}/api/health" >/dev/null 2>&1 || { echo "Error: scientific runtime did not become ready." >&2; exit 1; }

echo "==> Starting Node control plane on http://127.0.0.1:$CONTROL_PLANE_PORT"
cd "$PROJECT_DIR"
export PI_SCIENCE_PYTHON_ORIGIN="http://127.0.0.1:${SCIENTIFIC_RUNTIME_PORT}"
export PI_SCIENCE_BACKEND_URL="${PI_SCIENCE_BACKEND_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT}}"
export PI_SCIENCE_NODE_SESSIONS="${PI_SCIENCE_NODE_SESSIONS:-1}"
export PI_SCIENCE_NODE_SSE="${PI_SCIENCE_NODE_SSE:-1}"
export PI_SCIENCE_NODE_PI_MANAGER="${PI_SCIENCE_NODE_PI_MANAGER:-1}"
PI_SCIENCE_PORT="$CONTROL_PLANE_PORT" pnpm --config.store-dir="$PNPM_STORE_DIR" --filter @pi-science/server dev &
CONTROL_PLANE_PID=$!

echo "  Waiting for control plane..."
for _ in $(seq 1 30); do
  kill -0 "$CONTROL_PLANE_PID" 2>/dev/null || break
  curl --fail --silent "http://127.0.0.1:${CONTROL_PLANE_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl --fail --silent "http://127.0.0.1:${CONTROL_PLANE_PORT}/api/health" >/dev/null 2>&1 || { echo "Error: control plane did not become ready." >&2; exit 1; }

echo "==> Starting frontend on http://127.0.0.1:5173"
if ! port_is_available 5173; then
  if project_frontend_is_running; then
    FRONTEND_REUSED=true
    echo "  Reusing existing Pi-Science frontend on port 5173."
  else
    echo "Error: port 5173 is already in use." >&2
    exit 1
  fi
fi
if [ "$FRONTEND_REUSED" != true ]; then
  cd "$PROJECT_DIR/frontend"
  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$PROJECT_DIR/.cache/npm}"
  mkdir -p "$NPM_CONFIG_CACHE"
  export NPM_CONFIG_CACHE
  npm run dev -- --host 127.0.0.1 --port 5173 --strictPort &
  FRONTEND_PID=$!
  for _ in $(seq 1 30); do
    kill -0 "$FRONTEND_PID" 2>/dev/null || break
    curl --fail --silent http://127.0.0.1:5173 >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl --fail --silent http://127.0.0.1:5173 >/dev/null 2>&1 || { echo "Error: frontend did not become ready." >&2; exit 1; }
fi

echo ""
echo "Pi-Science is running:"
echo "  Frontend:          http://127.0.0.1:5173"
echo "  Node control plane: http://127.0.0.1:$CONTROL_PLANE_PORT"
echo "  Python runtime:     http://127.0.0.1:$SCIENTIFIC_RUNTIME_PORT"
echo "  API docs:           http://127.0.0.1:$CONTROL_PLANE_PORT/docs"
echo "Press Ctrl+C to stop."
wait
