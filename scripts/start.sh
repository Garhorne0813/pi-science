#!/usr/bin/env bash
# start.sh — start already-installed Pi-Science services.
# Usage: bash scripts/start.sh
set -euo pipefail

if [ "${1:-}" = "--launch-token" ]; then
  [ "$#" -eq 2 ] || { echo "Error: invalid launcher identity arguments." >&2; exit 2; }
  export PI_SCIENCE_LAUNCH_TOKEN="$2"
  shift 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_STATE_FILE="$PROJECT_DIR/.runtime/pi-science/install.env"
source "$SCRIPT_DIR/node-runtime.sh"
if [ -f "$INSTALL_STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$INSTALL_STATE_FILE"
fi

PI_CLI="${PI_CLI_PATH:-${PI_SCIENCE_INSTALL_PI_CLI:-}}"
[ -f "$PI_CLI" ] || { echo "Error: Pi runtime is not installed. Run: bash scripts/install.sh" >&2; exit 1; }
if ! pi_science_prepare_node 0; then
  pi_science_node_error
  exit 1
fi
NODE_COMMAND="$PI_SCIENCE_NODE_COMMAND"
PI_NODE_PATH="$PI_SCIENCE_NODE_COMMAND"
CONTROL_PLANE_CLI="$PROJECT_DIR/apps/server/node_modules/tsx/dist/cli.mjs"
VITE_BIN="$PROJECT_DIR/frontend/node_modules/.bin/vite"
[ -f "$CONTROL_PLANE_CLI" ] || { echo "Error: server dependencies are not installed. Run: bash scripts/install.sh" >&2; exit 1; }
[ -x "$VITE_BIN" ] || { echo "Error: frontend dependencies are not installed. Run: bash scripts/install.sh" >&2; exit 1; }

CONTROL_PLANE_PID=""
CONTROL_PLANE_STARTED=""
FRONTEND_PID=""
FRONTEND_STARTED=""
CONTROL_PLANE_PORT="${PI_SCIENCE_CONTROL_PLANE_PORT:-8787}"
FRONTEND_PORT="${PI_SCIENCE_FRONTEND_PORT:-5173}"
STARTUP_TIMEOUT_SECONDS="${PI_SCIENCE_STARTUP_TIMEOUT_SECONDS:-90}"
case "$STARTUP_TIMEOUT_SECONDS" in ''|*[!0-9]*) echo "Error: PI_SCIENCE_STARTUP_TIMEOUT_SECONDS must be a positive integer." >&2; exit 1 ;; esac
[ "$STARTUP_TIMEOUT_SECONDS" -gt 0 ] || { echo "Error: PI_SCIENCE_STARTUP_TIMEOUT_SECONDS must be a positive integer." >&2; exit 1; }
STARTUP_DEADLINE=$(( $(date +%s) + STARTUP_TIMEOUT_SECONDS ))
# The control plane runs directly (stable mode) by default. `tsx watch` under a
# detached supervisor sends SIGTERM to its child shortly after startup and never
# restarts it, so watch mode is an explicit development opt-in only.
CONTROL_PLANE_MODE="stable"
case "${PI_SCIENCE_SERVER_WATCH:-0}" in
  0) ;;
  1) CONTROL_PLANE_MODE="watch" ;;
  *) echo "Error: PI_SCIENCE_SERVER_WATCH must be 0 or 1." >&2; exit 1 ;;
esac

process_start_identity() {
  if [ -n "${PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR:-}" ] && [ -f "$PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR/$1" ]; then cat "$PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR/$1"; return; fi
  if [ -r "/proc/$1/stat" ]; then local value fields; value="$(cat "/proc/$1/stat" 2>/dev/null || true)"; fields="${value##*) }"; set -- $fields; [ "$#" -ge 20 ] && { shift 19; printf 'linux-proc-start-ticks:%s\n' "$1"; return; }; fi
  ps -ww -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -n 1
}

process_tree_pids() {
  local root="$1" previous="" current="$root"
  while [ "$current" != "$previous" ]; do
    previous="$current"
    while read -r pid ppid; do
      case " $current " in *" $ppid "*) case " $current " in *" $pid "*) ;; *) current="$current $pid" ;; esac ;; esac
    done < <(ps -eo pid=,ppid= 2>/dev/null || true)
  done
  printf '%s\n' $current
}

process_tree_snapshot() { local root="$1" expected="$2" pid identity; identity="$(process_start_identity "$root")"; [ -n "$expected" ] && [ "$identity" = "$expected" ] || return 0; for pid in $(process_tree_pids "$root"); do identity="$(process_start_identity "$pid")"; [ -n "$identity" ] && printf '%s\t%s\n' "$pid" "$identity" || true; done; return 0; }
signal_snapshot() { local snapshot="$1" signal="$2" pid identity current; while IFS=$'\t' read -r pid identity; do [ -n "$pid" ] || continue; current="$(process_start_identity "$pid")"; [ -n "$current" ] && [ "$current" = "$identity" ] && kill -"$signal" "$pid" 2>/dev/null || true; done <<EOF
$snapshot
EOF
}
snapshot_has_live_identity() { local snapshot="$1" pid identity current; while IFS=$'\t' read -r pid identity; do [ -n "$pid" ] || continue; current="$(process_start_identity "$pid")"; [ -n "$current" ] && [ "$current" = "$identity" ] && return 0; done <<EOF
$snapshot
EOF
  return 1
}

stop_owned_process() {
  set +e
  local root="$1" expected="$2" waited=0 initial final all
  [ -n "$root" ] && [ -n "$expected" ] && [ "$(process_start_identity "$root")" = "$expected" ] || { set -e; return 0; }
  initial="$(process_tree_snapshot "$root" "$expected")"
  [ -n "$initial" ] || return 0
  [ "$(process_start_identity "$root")" = "$expected" ] && signal_snapshot "$(printf '%s\n' "$initial" | head -n 1)" TERM
  while [ "$waited" -lt 50 ]; do
    [ "$(process_start_identity "$root")" = "$expected" ] || break
    snapshot_has_live_identity "$initial" || break
    sleep 0.1
    waited=$((waited + 1))
  done
  local root_current
  root_current="$(process_start_identity "$root")"
  final="$(process_tree_snapshot "$root" "$expected")"
  all="$initial${final:+
$final}"
  if [ "$root_current" = "$expected" ]; then signal_snapshot "$all" KILL
  elif ! kill -0 "$root" 2>/dev/null; then signal_snapshot "$initial" KILL
  fi
  wait "$root" 2>/dev/null || true
  set -e
  return 0
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$CONTROL_PLANE_PID$FRONTEND_PID" ]; then echo ""; echo "==> Shutting down..."; fi
  [ -z "$FRONTEND_PID" ] || stop_owned_process "$FRONTEND_PID" "$FRONTEND_STARTED"
  [ -z "$CONTROL_PLANE_PID" ] || stop_owned_process "$CONTROL_PLANE_PID" "$CONTROL_PLANE_STARTED"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_is_available() {
  "$NODE_COMMAND" -e 'const net=require("net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)));' "$1" >/dev/null 2>&1
}

wait_for_health() {
  local pid="$1" url="$2" label="$3"
  while [ "$(date +%s)" -lt "$STARTUP_DEADLINE" ]; do
    kill -0 "$pid" 2>/dev/null || { echo "Error: $label exited during startup." >&2; return 1; }
    curl --fail --silent "$url" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  curl --fail --silent "$url" >/dev/null 2>&1 && return 0
  echo "Error: $label did not become ready within the ${STARTUP_TIMEOUT_SECONDS}s startup deadline." >&2
  return 1
}

export PI_CLI_PATH="$PI_CLI"
export PI_NODE_PATH
export PI_SCIENCE_HOME="${PI_SCIENCE_HOME:-$HOME/.pi-science}"
export PI_SCIENCE_WORKSPACES="${PI_SCIENCE_WORKSPACES:-$HOME/pi-science-workspaces}"
export PI_SCIENCE_INTERNAL_TOKEN="${PI_SCIENCE_INTERNAL_TOKEN:-$(openssl rand -hex 32 2>/dev/null || date +%s)}"
export PI_SCIENCE_REQUIRE_INTERNAL_TOKEN="${PI_SCIENCE_REQUIRE_INTERNAL_TOKEN:-1}"
mkdir -p "$PI_SCIENCE_HOME/sessions" "$PI_SCIENCE_WORKSPACES"

if ! port_is_available "$CONTROL_PLANE_PORT"; then
  echo "Error: port $CONTROL_PLANE_PORT is already in use." >&2
  exit 1
fi

echo "==> Starting Node control plane on http://127.0.0.1:$CONTROL_PLANE_PORT (control plane mode: $CONTROL_PLANE_MODE)"
cd "$PROJECT_DIR"
export PI_SCIENCE_BACKEND_URL="${PI_SCIENCE_BACKEND_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT}}"
export PI_SCIENCE_NODE_SESSIONS="${PI_SCIENCE_NODE_SESSIONS:-1}"
export PI_SCIENCE_NODE_SSE="${PI_SCIENCE_NODE_SSE:-1}"
export PI_SCIENCE_NODE_PI_MANAGER="${PI_SCIENCE_NODE_PI_MANAGER:-1}"
(
  cd "$PROJECT_DIR/apps/server"
  if [ "$CONTROL_PLANE_MODE" = "watch" ]; then
    PI_SCIENCE_OPEN_BROWSER=0 PI_SCIENCE_PORT="$CONTROL_PLANE_PORT" exec "$PI_NODE_PATH" "$CONTROL_PLANE_CLI" watch src/app/main.ts
  else
    PI_SCIENCE_OPEN_BROWSER=0 PI_SCIENCE_PORT="$CONTROL_PLANE_PORT" exec "$PI_NODE_PATH" "$CONTROL_PLANE_CLI" src/app/main.ts
  fi
) &
CONTROL_PLANE_PID=$!
CONTROL_PLANE_STARTED="$(process_start_identity "$CONTROL_PLANE_PID")"
[ -n "$CONTROL_PLANE_STARTED" ] || { echo "Error: unable to establish control-plane process identity." >&2; exit 1; }

echo "  Waiting for control plane..."
wait_for_health "$CONTROL_PLANE_PID" "http://127.0.0.1:${CONTROL_PLANE_PORT}/internal/ready" "control plane"

echo "==> Starting frontend on http://127.0.0.1:$FRONTEND_PORT"
port_is_available "$FRONTEND_PORT" || { echo "Error: port $FRONTEND_PORT is already in use; refusing to reuse an unverified frontend." >&2; exit 1; }
(
  cd "$PROJECT_DIR/frontend"
  exec "$VITE_BIN" --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!
FRONTEND_STARTED="$(process_start_identity "$FRONTEND_PID")"
[ -n "$FRONTEND_STARTED" ] || { echo "Error: unable to establish frontend process identity." >&2; exit 1; }
wait_for_health "$FRONTEND_PID" "http://127.0.0.1:$FRONTEND_PORT" "frontend"

if [ "${PI_SCIENCE_OPEN_BROWSER:-0}" = "1" ]; then
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$FRONTEND_PORT" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$FRONTEND_PORT" >/dev/null 2>&1 || true
  fi
fi

echo ""
echo "Pi-Science is running:"
echo "  Frontend:          http://127.0.0.1:$FRONTEND_PORT"
echo "  Node control plane: http://127.0.0.1:$CONTROL_PLANE_PORT"
echo "Press Ctrl+C to stop."
wait
