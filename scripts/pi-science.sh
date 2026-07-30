#!/usr/bin/env bash
# pi-science — the command installed on PATH by scripts/install.sh.
#
# Usage:
#   pi-science [start] [--detach] [--no-open]   start the services
#   pi-science stop                             stop the services
#   pi-science status                           report what is running
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="$PROJECT_DIR/.runtime/pi-science"
PID_FILE="$RUN_DIR/run.pid"
LOG_FILE="$RUN_DIR/pi-science.log"
CONTROL_PLANE_PORT="${PI_SCIENCE_CONTROL_PLANE_PORT:-8787}"
SCIENTIFIC_RUNTIME_PORT="${PI_SCIENCE_RUNTIME_PORT:-8788}"
FRONTEND_PORT="${PI_SCIENCE_FRONTEND_PORT:-5173}"
FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
READY_TIMEOUT_SECONDS="${PI_SCIENCE_STARTUP_TIMEOUT_SECONDS:-90}"

usage() {
  cat <<'EOF'
pi-science — Scientific AI Workbench

Usage:
  pi-science [start] [options]   Start the control plane and the frontend
  pi-science stop                Stop services started from this checkout
  pi-science status              Report what is currently running
  pi-science help                Show this message

Start options:
  -d, --detach   Keep running in the background instead of holding the terminal
      --no-open  Do not open the browser once the app is ready
EOF
}

control_plane_is_ready() {
  curl --fail --silent "http://127.0.0.1:${CONTROL_PLANE_PORT}/api/health" >/dev/null 2>&1
}

frontend_is_ready() {
  curl --fail --silent "$FRONTEND_URL" >/dev/null 2>&1
}

port_listener_pids() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

# Only ever signal processes whose working directory is inside this checkout, so
# an unrelated service on the same port is reported rather than killed.
pid_belongs_to_project() {
  local cwd
  cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ -n "$cwd" ] && case "$cwd" in "$PROJECT_DIR"|"$PROJECT_DIR"/*) return 0 ;; esac
  return 1
}

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  fi
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

cmd_start() {
  local detach=false open=true
  while [ $# -gt 0 ]; do
    case "$1" in
      -d|--detach) detach=true ;;
      --no-open) open=false ;;
      *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done

  if control_plane_is_ready; then
    echo "Pi-Science is already running at $FRONTEND_URL"
    [ "$open" = true ] && open_browser "$FRONTEND_URL"
    return 0
  fi

  if [ "$detach" != true ]; then
    [ "$open" = true ] && export PI_SCIENCE_OPEN_BROWSER=1
    exec bash "$SCRIPT_DIR/start.sh"
  fi

  mkdir -p "$RUN_DIR"
  nohup bash "$SCRIPT_DIR/start.sh" >"$LOG_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"

  local waited=0
  while [ "$waited" -lt "$READY_TIMEOUT_SECONDS" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Error: Pi-Science exited during startup. Last lines of $LOG_FILE:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    if control_plane_is_ready && frontend_is_ready; then
      echo "Pi-Science is running in the background (pid $pid)"
      echo "  Frontend:           $FRONTEND_URL"
      echo "  Node control plane: http://127.0.0.1:$CONTROL_PLANE_PORT"
      echo "  Logs:               $LOG_FILE"
      echo "  Stop with:          pi-science stop"
      [ "$open" = true ] && open_browser "$FRONTEND_URL"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "Error: Pi-Science did not become ready within ${READY_TIMEOUT_SECONDS}s. See $LOG_FILE" >&2
  exit 1
}

stop_pid() {
  local pid="$1" waited=0
  kill "$pid" 2>/dev/null || return 0
  while [ "$waited" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
}

cmd_stop() {
  local stopped=false pid
  if pid="$(running_pid)"; then
    stop_pid "$pid"
    rm -f "$PID_FILE"
    stopped=true
  fi
  rm -f "$PID_FILE"

  # A foreground start leaves no pid file, and a detached one can outlive its
  # supervisor, so sweep the ports this checkout owns as well.
  local port
  for port in "$CONTROL_PLANE_PORT" "$FRONTEND_PORT" "$SCIENTIFIC_RUNTIME_PORT"; do
    while read -r listener; do
      [ -n "$listener" ] || continue
      if pid_belongs_to_project "$listener"; then
        stop_pid "$listener"
        stopped=true
      else
        echo "Note: port $port is held by pid $listener from outside this checkout; leaving it alone." >&2
      fi
    done < <(port_listener_pids "$port")
  done

  if [ "$stopped" = true ]; then echo "Pi-Science stopped."
  else echo "Pi-Science is not running."
  fi
}

cmd_status() {
  local pid
  if pid="$(running_pid)"; then echo "Supervisor:         running (pid $pid, logs at $LOG_FILE)"
  else echo "Supervisor:         not started by 'pi-science start --detach'"
  fi
  if control_plane_is_ready; then echo "Node control plane: ready at http://127.0.0.1:$CONTROL_PLANE_PORT"
  else echo "Node control plane: not responding on port $CONTROL_PLANE_PORT"
  fi
  if frontend_is_ready; then echo "Frontend:           ready at $FRONTEND_URL"
  else echo "Frontend:           not responding on port $FRONTEND_PORT"
  fi
  if [ -n "$(port_listener_pids "$SCIENTIFIC_RUNTIME_PORT")" ]; then echo "Python worker:      listening on port $SCIENTIFIC_RUNTIME_PORT"
  else echo "Python worker:      idle (started on demand)"
  fi
  echo "Checkout:           $PROJECT_DIR"
}

command="${1:-start}"
[ $# -gt 0 ] && shift || true
case "$command" in
  start) cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  help|-h|--help) usage ;;
  -*) cmd_start "$command" "$@" ;;
  *) echo "Unknown command: $command" >&2; usage >&2; exit 2 ;;
esac
