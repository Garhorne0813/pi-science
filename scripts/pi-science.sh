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
STATE_DIR="$RUN_DIR/run.state"
LEGACY_PID_FILE="$RUN_DIR/run.pid"
LOG_FILE="$RUN_DIR/pi-science.log"
LAUNCH_LOCK_DIR="$RUN_DIR/start.lock"
CONTROL_PLANE_PORT="${PI_SCIENCE_CONTROL_PLANE_PORT:-8787}"
SCIENTIFIC_RUNTIME_PORT="${PI_SCIENCE_RUNTIME_PORT:-8788}"
FRONTEND_PORT="${PI_SCIENCE_FRONTEND_PORT:-5173}"
FRONTEND_URL="http://127.0.0.1:$FRONTEND_PORT"
READY_TIMEOUT_SECONDS="${PI_SCIENCE_STARTUP_TIMEOUT_SECONDS:-90}"
SUPERVISOR_CLEANUP_GRACE_TENTHS=120
STATE_PID="" STATE_TOKEN="" STATE_STARTED=""
LAUNCH_LOCK_TOKEN="" BOOTSTRAP_PID="" BOOTSTRAP_TOKEN="" BOOTSTRAP_ACTIVE=false

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

control_plane_is_ready() { curl --fail --silent "http://127.0.0.1:${CONTROL_PLANE_PORT}/api/health" >/dev/null 2>&1; }
frontend_is_ready() { curl --fail --silent "$FRONTEND_URL" >/dev/null 2>&1; }
port_listener_pids() { command -v lsof >/dev/null 2>&1 || return 0; lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true; }
open_browser() { if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 || true; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true; fi; }
process_start_identity() { if [ -n "${PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR:-}" ] && [ -f "$PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR/$1" ]; then cat "$PI_SCIENCE_TEST_PROCESS_IDENTITY_DIR/$1"; else ps -ww -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -n 1; fi; }
process_command() { ps -ww -o command= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//' | head -n 1; }

remove_run_state() { rm -rf "$STATE_DIR"; rm -f "$LEGACY_PID_FILE"; }
run_state_is_owned() { [ -n "$1" ] && [ -n "$2" ] && [ "$(cat "$STATE_DIR/pid" 2>/dev/null || true)" = "$1" ] && [ "$(cat "$STATE_DIR/token" 2>/dev/null || true)" = "$2" ]; }
acquire_launch_lock() {
  mkdir -p "$RUN_DIR"
  LAUNCH_LOCK_TOKEN="$$-${RANDOM:-0}-$(date +%s)"
  mkdir "$LAUNCH_LOCK_DIR" 2>/dev/null || { echo "Error: another Pi-Science detached launch transaction is active for this checkout." >&2; return 1; }
  printf '%s\n' "$LAUNCH_LOCK_TOKEN" > "$LAUNCH_LOCK_DIR/owner"
}
release_launch_lock() { if [ -n "$LAUNCH_LOCK_TOKEN" ] && [ "$(cat "$LAUNCH_LOCK_DIR/owner" 2>/dev/null || true)" = "$LAUNCH_LOCK_TOKEN" ]; then rm -rf "$LAUNCH_LOCK_DIR"; fi; LAUNCH_LOCK_TOKEN=""; }
bootstrap_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$BOOTSTRAP_ACTIVE" = true ]; then
    [ -z "$BOOTSTRAP_PID" ] || stop_process_tree "$BOOTSTRAP_PID"
    run_state_is_owned "$BOOTSTRAP_PID" "$BOOTSTRAP_TOKEN" && remove_run_state || true
  fi
  release_launch_lock
  exit "$status"
}
bootstrap_commit() { BOOTSTRAP_ACTIVE=false; release_launch_lock; trap - EXIT INT TERM; }
read_run_state() {
  STATE_PID="" STATE_TOKEN="" STATE_STARTED=""
  [ -d "$STATE_DIR" ] || { [ ! -e "$STATE_DIR" ] || remove_run_state; rm -f "$LEGACY_PID_FILE"; return 1; }
  STATE_PID="$(cat "$STATE_DIR/pid" 2>/dev/null || true)"
  STATE_TOKEN="$(cat "$STATE_DIR/token" 2>/dev/null || true)"
  STATE_STARTED="$(cat "$STATE_DIR/started" 2>/dev/null || true)"
  case "$STATE_PID" in ''|*[!0-9]*) remove_run_state; return 1 ;; esac
  case "$STATE_TOKEN" in ''|*[!A-Za-z0-9_-]*) remove_run_state; return 1 ;; esac
  [ -n "$STATE_STARTED" ] || { remove_run_state; return 1; }
  return 0
}

running_supervisor() {
  read_run_state || return 1
  if ! kill -0 "$STATE_PID" 2>/dev/null; then remove_run_state; return 1; fi
  local current_started command
  current_started="$(process_start_identity "$STATE_PID")"
  command="$(process_command "$STATE_PID")"
  if [ -z "$current_started" ] || [ "$current_started" != "$STATE_STARTED" ]; then remove_run_state; return 1; fi
  case "$command" in *"$SCRIPT_DIR/start.sh"*"--launch-token $STATE_TOKEN"*) ;; *) remove_run_state; return 1 ;; esac
  printf '%s' "$STATE_PID"
}

write_run_state() {
  local pid="$1" token="$2" started="$3" temp="$RUN_DIR/.run.state.$$.$token"
  rm -rf "$temp"; mkdir "$temp"
  printf '%s\n' "$pid" > "$temp/pid"
  printf '%s\n' "$token" > "$temp/token"
  printf '%s\n' "$started" > "$temp/started"
  printf '%s\n' "$PROJECT_DIR" > "$temp/checkout"
  rm -rf "$STATE_DIR"
  mv "$temp" "$STATE_DIR"
  rm -f "$LEGACY_PID_FILE"
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
process_tree_snapshot() { local pid identity; for pid in $(process_tree_pids "$1"); do identity="$(process_start_identity "$pid")"; [ -n "$identity" ] && printf '%s\t%s\n' "$pid" "$identity" || true; done; return 0; }
signal_snapshot() { local snapshot="$1" signal="$2" pid identity current; while IFS=$'\t' read -r pid identity; do [ -n "$pid" ] || continue; current="$(process_start_identity "$pid")"; [ -n "$current" ] && [ "$current" = "$identity" ] && kill -"$signal" "$pid" 2>/dev/null || true; done <<EOF
$snapshot
EOF
}
snapshot_has_live_identity() { local snapshot="$1" pid identity current; while IFS=$'\t' read -r pid identity; do [ -n "$pid" ] || continue; current="$(process_start_identity "$pid")"; [ -n "$current" ] && [ "$current" = "$identity" ] && return 0; done <<EOF
$snapshot
EOF
  return 1
}

stop_process_tree() {
  set +e
  local root="$1" waited=0 initial current all
  initial="$(process_tree_snapshot "$root")"
  [ -n "$initial" ] || return 0
  if [ -n "${PI_SCIENCE_TEST_PROCESS_SNAPSHOT_BARRIER:-}" ]; then
    : > "${PI_SCIENCE_TEST_PROCESS_SNAPSHOT_BARRIER}.ready"
    while [ ! -f "${PI_SCIENCE_TEST_PROCESS_SNAPSHOT_BARRIER}.release" ]; do sleep 0.01; done
  fi
  signal_snapshot "$(printf '%s\n' "$initial" | head -n 1)" TERM
  while [ "$waited" -lt "$SUPERVISOR_CLEANUP_GRACE_TENTHS" ]; do
    snapshot_has_live_identity "$initial" || break
    sleep 0.1; waited=$((waited + 1))
  done
  current="$(process_tree_snapshot "$root")"
  all="$initial${current:+
$current}"
  signal_snapshot "$all" KILL
  wait "$root" 2>/dev/null || true
  set -e
  return 0
}

cmd_start() {
  local detach=false open=true
  while [ $# -gt 0 ]; do case "$1" in -d|--detach) detach=true ;; --no-open) open=false ;; *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;; esac; shift; done

  if [ "$detach" = true ]; then
    acquire_launch_lock || exit 1
    BOOTSTRAP_ACTIVE=true
    trap bootstrap_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
  fi

  local existing=""
  existing="$(running_supervisor 2>/dev/null || true)"
  if [ -n "$existing" ] && control_plane_is_ready; then
    echo "Pi-Science is already running at $FRONTEND_URL"
    [ "$open" = true ] && open_browser "$FRONTEND_URL"
    [ "$detach" = true ] && bootstrap_commit
    return 0
  fi
  if control_plane_is_ready; then
    echo "Error: control-plane port $CONTROL_PLANE_PORT is already in use by an unverified process; refusing to reuse or stop it." >&2
    exit 1
  fi

  if [ "$detach" != true ]; then
    [ "$open" = true ] && export PI_SCIENCE_OPEN_BROWSER=1
    exec bash "$SCRIPT_DIR/start.sh"
  fi

  case "$READY_TIMEOUT_SECONDS" in ''|*[!0-9]*) echo "Error: PI_SCIENCE_STARTUP_TIMEOUT_SECONDS must be a positive integer." >&2; exit 2 ;; esac
  [ "$READY_TIMEOUT_SECONDS" -gt 0 ] || { echo "Error: PI_SCIENCE_STARTUP_TIMEOUT_SECONDS must be a positive integer." >&2; exit 2; }
  [ -z "$existing" ] || { echo "Error: a verified Pi-Science supervisor is still running but is not healthy; stop it first." >&2; exit 1; }

  mkdir -p "$RUN_DIR"
  local token pid started deadline cleanup_wait
  token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(18).toString("hex"))')"
  (cd "$PROJECT_DIR" && exec nohup bash "$SCRIPT_DIR/start.sh" --launch-token "$token") >"$LOG_FILE" 2>&1 &
  pid=$!
  BOOTSTRAP_PID="$pid"; BOOTSTRAP_TOKEN="$token"
  started=""
  for _ in $(seq 1 40); do started="$(process_start_identity "$pid")"; [ -n "$started" ] && break; kill -0 "$pid" 2>/dev/null || break; sleep 0.025; done
  if [ -z "$started" ]; then echo "Error: unable to establish detached supervisor identity." >&2; exit 1; fi
  if [ -n "${PI_SCIENCE_TEST_BOOTSTRAP_BARRIER:-}" ]; then
    : > "${PI_SCIENCE_TEST_BOOTSTRAP_BARRIER}.ready"
    while [ ! -f "${PI_SCIENCE_TEST_BOOTSTRAP_BARRIER}.release" ]; do sleep 0.01; done
  fi
  write_run_state "$pid" "$token" "$started"
  run_state_is_owned "$pid" "$token" || { echo "Error: detached supervisor state ownership was lost during startup." >&2; exit 1; }
  deadline=$(( $(date +%s) + READY_TIMEOUT_SECONDS ))

  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! running_supervisor >/dev/null 2>&1; then
      echo "Error: Pi-Science exited during startup. Last lines of $LOG_FILE:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      run_state_is_owned "$pid" "$token" && remove_run_state || true
      exit 1
    fi
    if control_plane_is_ready && frontend_is_ready; then
      echo "Pi-Science is running in the background (pid $pid)"
      echo "  Frontend:           $FRONTEND_URL"
      echo "  Node control plane: http://127.0.0.1:$CONTROL_PLANE_PORT"
      echo "  Logs:               $LOG_FILE"
      echo "  Stop with:          pi-science stop"
      run_state_is_owned "$pid" "$token" || { echo "Error: detached supervisor state ownership was lost before readiness." >&2; exit 1; }
      [ "$open" = true ] && open_browser "$FRONTEND_URL"
      bootstrap_commit
      return 0
    fi
    sleep 0.25
  done

  if control_plane_is_ready && frontend_is_ready; then run_state_is_owned "$pid" "$token" || { echo "Error: detached supervisor state ownership was lost before readiness." >&2; exit 1; }; echo "Pi-Science is running in the background (pid $pid)"; bootstrap_commit; return 0; fi
  echo "Error: Pi-Science did not become ready within ${READY_TIMEOUT_SECONDS}s. See $LOG_FILE" >&2
  cleanup_wait=0
  while [ "$cleanup_wait" -lt "$SUPERVISOR_CLEANUP_GRACE_TENTHS" ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; cleanup_wait=$((cleanup_wait + 1)); done
  kill -0 "$pid" 2>/dev/null && stop_process_tree "$pid" || true
  run_state_is_owned "$pid" "$token" && remove_run_state || true
  exit 1
}

cmd_stop() {
  local pid=""
  pid="$(running_supervisor 2>/dev/null || true)"
  if [ -n "$pid" ]; then stop_process_tree "$pid"; remove_run_state; echo "Pi-Science stopped."
  else remove_run_state; echo "Pi-Science is not running."
  fi
}

cmd_status() {
  local pid=""
  pid="$(running_supervisor 2>/dev/null || true)"
  if [ -n "$pid" ]; then echo "Supervisor:         running (pid $pid, logs at $LOG_FILE)"; else echo "Supervisor:         not started by 'pi-science start --detach'"; fi
  if control_plane_is_ready; then echo "Node control plane: ready at http://127.0.0.1:$CONTROL_PLANE_PORT"; else echo "Node control plane: not responding on port $CONTROL_PLANE_PORT"; fi
  if frontend_is_ready; then echo "Frontend:           ready at $FRONTEND_URL"; else echo "Frontend:           not responding on port $FRONTEND_PORT"; fi
  if [ -n "$(port_listener_pids "$SCIENTIFIC_RUNTIME_PORT")" ]; then echo "Python worker:      listening on port $SCIENTIFIC_RUNTIME_PORT"; else echo "Python worker:      idle (started on demand)"; fi
  echo "Checkout:           $PROJECT_DIR"
}

[ "${PI_SCIENCE_SOURCE_ONLY:-0}" = "1" ] && return 0
command="${1:-start}"
[ $# -gt 0 ] && shift || true
case "$command" in start) cmd_start "$@" ;; stop) cmd_stop ;; status) cmd_status ;; help|-h|--help) usage ;; -*) cmd_start "$command" "$@" ;; *) echo "Unknown command: $command" >&2; usage >&2; exit 2 ;; esac
