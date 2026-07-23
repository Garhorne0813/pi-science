#!/usr/bin/env bash
# Run an isolated smoke test for the Node gateway and Python runtime boundary.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEEP_TEMP=false
GATEWAY_ONLY=false
REAL_PI=false
NATIVE_READONLY=false

for arg in "$@"; do
    case "$arg" in
        --keep-temp) KEEP_TEMP=true ;;
        --gateway-only) GATEWAY_ONLY=true ;;
        --real-pi) REAL_PI=true ;;
        --native-readonly) NATIVE_READONLY=true ;;
        *) echo "unknown option: $arg" >&2; exit 10 ;;
    esac
done

if ! command -v curl >/dev/null 2>&1; then echo "curl is required" >&2; exit 10; fi
if ! command -v python3 >/dev/null 2>&1; then echo "python3 is required" >&2; exit 10; fi
if ! command -v pnpm >/dev/null 2>&1; then echo "pnpm is required" >&2; exit 10; fi
if ! command -v uv >/dev/null 2>&1; then echo "uv is required" >&2; exit 10; fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-science-smoke.XXXXXX")"
PY_LOG="$TEMP_DIR/python.log"
NODE_LOG="$TEMP_DIR/node.log"
PY_PID=""
NODE_PID=""
SSE_PID=""

pick_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

PY_PORT="$(pick_port)"
NODE_PORT="$(pick_port)"
export PI_SCIENCE_HOME="$TEMP_DIR/data"
export PI_SCIENCE_WORKSPACES="$TEMP_DIR/workspaces"
mkdir -p "$PI_SCIENCE_HOME" "$PI_SCIENCE_WORKSPACES"
export UV_CACHE_DIR="$TEMP_DIR/uv-cache"
export PI_SCIENCE_INTERNAL_TOKEN="smoke-internal-token"
export PI_SCIENCE_REQUIRE_INTERNAL_TOKEN=1
mkdir -p "$UV_CACHE_DIR"
SMOKE_WORKSPACE="$TEMP_DIR/workspace"
mkdir -p "$SMOKE_WORKSPACE/.pi-science"
printf 'smoke\n' > "$SMOKE_WORKSPACE/notes.txt"

cleanup() {
    local exit_code=$?
    if [ -n "$SSE_PID" ]; then kill "$SSE_PID" 2>/dev/null || true; fi
    if [ -n "$NODE_PID" ]; then kill "$NODE_PID" 2>/dev/null || true; fi
    if [ -n "$PY_PID" ]; then kill "$PY_PID" 2>/dev/null || true; fi
    wait 2>/dev/null || true
    if [ "$KEEP_TEMP" = true ] || [ "$exit_code" -ne 0 ]; then
        echo "smoke artifacts: $TEMP_DIR" >&2
    else
        rm -rf "$TEMP_DIR"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

if [ "$REAL_PI" = true ] && [ -z "${PI_CLI_PATH:-}" ]; then
    echo "--real-pi requires PI_CLI_PATH" >&2
    exit 10
fi

echo "[smoke] building Node server"
(cd "$ROOT_DIR" && pnpm --filter @pi-science/server build >/dev/null)

echo "[smoke] starting Python runtime on $PY_PORT"
(
    cd "$ROOT_DIR/backend"
    env PI_SCIENCE_HOME="$PI_SCIENCE_HOME" PI_SCIENCE_WORKSPACES="$PI_SCIENCE_WORKSPACES" \
        PI_SCIENCE_PORT="$PY_PORT" PI_SCIENCE_CORS="http://127.0.0.1:5173" \
        PI_SCIENCE_INTERNAL_TOKEN="$PI_SCIENCE_INTERNAL_TOKEN" PI_SCIENCE_REQUIRE_INTERNAL_TOKEN=1 \
        PI_CLI_PATH="${PI_CLI_PATH:-}" UV_CACHE_DIR="$UV_CACHE_DIR" uv run uvicorn main:app --host 127.0.0.1 --port "$PY_PORT"
) >"$PY_LOG" 2>&1 &
PY_PID=$!

wait_http() {
    local url="$1"
    local attempts=0
    while [ "$attempts" -lt 40 ]; do
        if curl --fail --silent "$url" >/dev/null 2>&1; then return 0; fi
        attempts=$((attempts + 1))
        sleep 0.25
    done
    return 1
}

if ! wait_http "http://127.0.0.1:${PY_PORT}/api/health"; then
    echo "Python runtime did not become ready" >&2
    sed -n '1,120p' "$PY_LOG" >&2 || true
    exit 20
fi

echo "[smoke] starting Node gateway on $NODE_PORT"
NODE_MIGRATION_FLAGS=(PI_SCIENCE_NODE_SESSIONS=1 PI_SCIENCE_NODE_SSE=1 PI_SCIENCE_NODE_PI_MANAGER=1)
if [ "$NATIVE_READONLY" = true ]; then
    NODE_MIGRATION_FLAGS+=(PI_SCIENCE_NODE_FILES=1)
fi
(
    cd "$ROOT_DIR"
    env PI_SCIENCE_PORT="$NODE_PORT" PI_SCIENCE_PYTHON_ORIGIN="http://127.0.0.1:${PY_PORT}" \
        PI_SCIENCE_CORS="http://127.0.0.1:5173" PI_SCIENCE_INTERNAL_TOKEN="$PI_SCIENCE_INTERNAL_TOKEN" \
        PI_CLI_PATH="${PI_CLI_PATH:-}" PI_NODE_PATH="${PI_NODE_PATH:-$(command -v node)}" \
        "${NODE_MIGRATION_FLAGS[@]}" pnpm --filter @pi-science/server start
) >"$NODE_LOG" 2>&1 &
NODE_PID=$!

if ! wait_http "http://127.0.0.1:${NODE_PORT}/internal/live"; then
    echo "Node gateway did not become ready" >&2
    sed -n '1,120p' "$NODE_LOG" >&2 || true
    exit 30
fi

assert_status() {
    local expected="$1"
    local url="$2"
    local actual
    actual="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$url")"
    if [ "$actual" != "$expected" ]; then
        echo "expected HTTP $expected from $url, got $actual" >&2
        exit 40
    fi
}

assert_body_contains() {
    local needle="$1"
    local url="$2"
    local body
    body="$(curl --fail --silent --show-error "$url")"
    if ! grep -Fq -- "$needle" <<<"$body"; then
        echo "response from $url did not contain: $needle" >&2
        exit 40
    fi
}

assert_header_file_contains() {
    local header_file="$1"
    local needle="$2"
    if ! grep -Fqi -- "$needle" "$header_file"; then
        echo "response headers did not contain: $needle" >&2
        sed -n '1,80p' "$header_file" >&2 || true
        exit 40
    fi
}

wait_for_file_match() {
    local file="$1"
    local pattern="$2"
    local attempts="${3:-100}"
    local count=0
    while [ "$count" -lt "$attempts" ]; do
        if [ -f "$file" ] && grep -Eq -- "$pattern" "$file"; then return 0; fi
        count=$((count + 1))
        sleep 0.1
    done
    return 1
}

echo "[smoke] liveness and readiness"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/internal/live"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/internal/ready"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/api/health"
assert_body_contains '"control_plane":"node"' "http://127.0.0.1:${NODE_PORT}/api/health"
HEALTH_HEADERS="$TEMP_DIR/health.headers"
curl --fail --silent --show-error --dump-header "$HEALTH_HEADERS" --output /dev/null \
    "http://127.0.0.1:${NODE_PORT}/api/health"
assert_header_file_contains "$HEALTH_HEADERS" 'x-pi-science-runtime: node-control-plane'

echo "[smoke] compatibility proxy"
assert_status 403 "http://127.0.0.1:${PY_PORT}/api/settings/config"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/api/kernels/status"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/api/settings/config"
assert_body_contains '"api_keys"' "http://127.0.0.1:${NODE_PORT}/api/settings/config"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/openapi.json"
assert_status 200 "http://127.0.0.1:${NODE_PORT}/docs"

WORKSPACE_Q="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SMOKE_WORKSPACE")"

echo "[smoke] native settings, files, artifacts, jobs, and provenance"
SETTINGS_JSON="$(curl --fail --silent --show-error -X PUT \
    -H 'Content-Type: application/json' \
    -d '{"provider":"openai","api_key":"smoke-secret"}' \
    "http://127.0.0.1:${NODE_PORT}/api/settings/api-key")"
if ! echo "$SETTINGS_JSON" | grep -q '"ok":true'; then
    echo "settings api-key write failed" >&2
    exit 40
fi
CONFIG_JSON="$(curl --fail --silent --show-error "http://127.0.0.1:${NODE_PORT}/api/settings/config")"
if ! echo "$CONFIG_JSON" | grep -q '"openai":true'; then
    echo "settings key presence was not persisted" >&2
    exit 40
fi
if echo "$CONFIG_JSON" | grep -q 'smoke-secret'; then
    echo "settings leaked an API key" >&2
    exit 40
fi

CUSTOM_PROVIDER_JSON="$(curl --fail --silent --show-error -X PUT \
    -H 'Content-Type: application/json' \
    -d '{"name":"Smoke Provider","base_url":"https://llm.example.com/v1","api_key":"custom-secret","api":"openai-completions","models":["smoke-model"]}' \
    "http://127.0.0.1:${NODE_PORT}/api/settings/custom-providers/smoke-provider")"
if ! echo "$CUSTOM_PROVIDER_JSON" | grep -q '"ok":true'; then
    echo "custom provider write failed" >&2
    exit 40
fi
if echo "$CUSTOM_PROVIDER_JSON" | grep -q 'custom-secret'; then
    echo "custom provider API key leaked" >&2
    exit 40
fi
assert_body_contains 'custom-smoke-provider/smoke-model' "http://127.0.0.1:${NODE_PORT}/api/settings/config"

KEYLESS_PROVIDER_JSON="$(curl --fail --silent --show-error -X PUT \
    -H 'Content-Type: application/json' \
    -d '{"name":"Local No-Key Provider","base_url":"http://127.0.0.1:11434/v1","api":"openai-completions","models":["local-model"]}' \
    "http://127.0.0.1:${NODE_PORT}/api/settings/custom-providers/local-no-key")"
if ! echo "$KEYLESS_PROVIDER_JSON" | grep -q '"ok":true'; then
    echo "keyless custom provider write failed" >&2
    exit 40
fi
assert_body_contains 'custom-local-no-key/local-model' "http://127.0.0.1:${NODE_PORT}/api/settings/config"
curl --fail --silent --show-error -X DELETE \
    "http://127.0.0.1:${NODE_PORT}/api/settings/custom-providers/smoke-provider" >/dev/null
curl --fail --silent --show-error -X DELETE \
    "http://127.0.0.1:${NODE_PORT}/api/settings/custom-providers/local-no-key" >/dev/null

curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
    -d '{"filename":"uploaded.txt","content":"smoke-upload"}' \
    "http://127.0.0.1:${NODE_PORT}/api/files/upload?cwd=${WORKSPACE_Q}" >/dev/null
curl --fail --silent --show-error -X POST -F "file=@${ROOT_DIR}/README.md" \
    "http://127.0.0.1:${NODE_PORT}/api/files/upload?cwd=${WORKSPACE_Q}" >/dev/null
curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
    -d '{"source":"uploaded.txt","target":"renamed.txt"}' \
    "http://127.0.0.1:${NODE_PORT}/api/files/rename?cwd=${WORKSPACE_Q}" >/dev/null
ARTIFACT_JSON="$(curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
    -d '{"path":"renamed.txt","session_id":"smoke-session"}' \
    "http://127.0.0.1:${NODE_PORT}/api/artifacts/publish?cwd=${WORKSPACE_Q}")"
if ! echo "$ARTIFACT_JSON" | grep -q '"version":1'; then
    echo "artifact publication failed" >&2
    exit 40
fi

JOB_JSON="$(curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
    -d '{"command":["node","-e","process.stdout.write(\"smoke-job\")"]}' \
    "http://127.0.0.1:${NODE_PORT}/api/jobs?cwd=${WORKSPACE_Q}")"
JOB_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["job_id"])' "$JOB_JSON")"
JOB_STATE=''
for _ in $(seq 1 30); do
    JOB_STATE="$(curl --fail --silent --show-error "http://127.0.0.1:${NODE_PORT}/api/jobs/${JOB_ID}?cwd=${WORKSPACE_Q}")"
    if echo "$JOB_STATE" | grep -Eq '"status":"(succeeded|failed|cancelled|timed_out)"'; then break; fi
    sleep 0.1
done
if ! echo "$JOB_STATE" | grep -q '"status":"succeeded"'; then
    echo "job did not succeed: $JOB_STATE" >&2
    exit 40
fi
assert_body_contains '"records"' "http://127.0.0.1:${NODE_PORT}/api/provenance?cwd=${WORKSPACE_Q}"

echo "[smoke] native project memory and cleanup"
LOOP_JSON="$(curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
    -d '{"title":"Smoke loop","objective":"Validate native control plane"}' \
    "http://127.0.0.1:${NODE_PORT}/api/project-memory/research-loops?cwd=${WORKSPACE_Q}")"
LOOP_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["loop_id"])' "$LOOP_JSON")"
curl --fail --silent --show-error -X POST \
    "http://127.0.0.1:${NODE_PORT}/api/project-memory/research-loops/${LOOP_ID}/cancel?cwd=${WORKSPACE_Q}" >/dev/null
assert_body_contains '"cancelled"' "http://127.0.0.1:${NODE_PORT}/api/project-memory/research-loops?cwd=${WORKSPACE_Q}"
curl --fail --silent --show-error -X DELETE \
    "http://127.0.0.1:${NODE_PORT}/api/files/renamed.txt?cwd=${WORKSPACE_Q}" >/dev/null

echo "[smoke] CORS and request ID"
CORS_HEADERS="$TEMP_DIR/cors.headers"
curl --fail --silent --show-error --dump-header "$CORS_HEADERS" --output /dev/null \
    -H 'Origin: http://127.0.0.1:5173' "http://127.0.0.1:${NODE_PORT}/api/health"
assert_header_file_contains "$CORS_HEADERS" 'access-control-allow-origin: http://127.0.0.1:5173'

if [ "$GATEWAY_ONLY" = false ]; then
    echo "[smoke] frontend proxy configuration"
    if ! grep -Eq '127\.0\.0\.1:8787' "$ROOT_DIR/frontend/vite.config.ts"; then
        echo "frontend default proxy is not configured for Node control plane" >&2
        exit 40
    fi
fi

if [ "$NATIVE_READONLY" = true ]; then
    echo "[smoke] native read-only routes"
    assert_status 200 "http://127.0.0.1:${NODE_PORT}/api/sessions?cwd=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SMOKE_WORKSPACE")"
    assert_body_contains 'notes.txt' "http://127.0.0.1:${NODE_PORT}/api/files?cwd=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$SMOKE_WORKSPACE")"
fi

if [ "$REAL_PI" = true ]; then
    echo "[smoke] real Pi uses Node-native sessions, SSE, and Pi manager"
    SESSION_A_HEADERS="$TEMP_DIR/session-a.headers"
    SESSION_JSON="$(curl --fail --silent --show-error --dump-header "$SESSION_A_HEADERS" -X POST \
        -H 'Content-Type: application/json' \
        -d "{\"cwd\":\"${SMOKE_WORKSPACE}\"}" \
        "http://127.0.0.1:${NODE_PORT}/api/sessions")"
    SESSION_A="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$SESSION_JSON")"
    if [ -z "$SESSION_A" ]; then
        echo "real Pi did not return a session id" >&2
        exit 50
    fi
    assert_header_file_contains "$SESSION_A_HEADERS" 'x-pi-science-runtime: node-control-plane'

    STATE_A_HEADERS="$TEMP_DIR/state-a.headers"
    STATE_A_JSON="$(curl --fail --silent --show-error --dump-header "$STATE_A_HEADERS" \
        "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_A}/state?cwd=${WORKSPACE_Q}")"
    assert_header_file_contains "$STATE_A_HEADERS" 'x-pi-science-runtime: node-control-plane'
    if ! echo "$STATE_A_JSON" | grep -Fq -- "\"id\":\"${SESSION_A}\""; then
        echo "state did not identify session A: $STATE_A_JSON" >&2
        exit 50
    fi

    SSE_HEADERS="$TEMP_DIR/session-a-sse.headers"
    SSE_BODY="$TEMP_DIR/session-a-sse.body"
    (curl --silent --show-error --no-buffer --max-time 130 \
        --dump-header "$SSE_HEADERS" --output "$SSE_BODY" \
        "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_A}/events?cwd=${WORKSPACE_Q}" || true) &
    SSE_PID=$!
    if ! wait_for_file_match "$SSE_HEADERS" 'x-pi-science-sse: node-native' 100; then
        echo "Node-native SSE did not open" >&2
        sed -n '1,80p' "$SSE_HEADERS" >&2 || true
        exit 50
    fi
    assert_header_file_contains "$SSE_HEADERS" 'x-pi-science-runtime: node-control-plane'

    SESSION_MODEL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("model") or "")' "$STATE_A_JSON")"
    if [ -n "$SESSION_MODEL" ]; then
        echo "[smoke] prompt with configured Pi model: $SESSION_MODEL"
        PROMPT_HEADERS="$TEMP_DIR/prompt.headers"
        PROMPT_JSON="$(curl --fail --silent --show-error --dump-header "$PROMPT_HEADERS" -X POST \
            -H 'Content-Type: application/json' \
            -d '{"message":"Reply with exactly NODE_NATIVE_SMOKE_OK"}' \
            "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_A}/prompt?cwd=${WORKSPACE_Q}")"
        assert_header_file_contains "$PROMPT_HEADERS" 'x-pi-science-runtime: node-control-plane'
        if ! echo "$PROMPT_JSON" | grep -q '"ok":true'; then
            echo "prompt was not accepted: $PROMPT_JSON" >&2
            exit 50
        fi
        if ! wait_for_file_match "$SSE_BODY" '"type":"(session\.idle|error)"' 1200; then
            echo "prompt did not produce a terminal Node SSE event" >&2
            sed -n '1,160p' "$SSE_BODY" >&2 || true
            exit 50
        fi
    else
        echo "[smoke] no Pi model configured; prompt portion skipped"
    fi
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
    SSE_PID=""

    echo "[smoke] session switching and fork"
    SESSION_B_HEADERS="$TEMP_DIR/session-b.headers"
    SESSION_B_JSON="$(curl --fail --silent --show-error --dump-header "$SESSION_B_HEADERS" -X POST \
        -H 'Content-Type: application/json' -d "{\"cwd\":\"${SMOKE_WORKSPACE}\"}" \
        "http://127.0.0.1:${NODE_PORT}/api/sessions")"
    SESSION_B="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$SESSION_B_JSON")"
    assert_header_file_contains "$SESSION_B_HEADERS" 'x-pi-science-runtime: node-control-plane'
    if [ -z "$SESSION_B" ] || [ "$SESSION_B" = "$SESSION_A" ]; then
        echo "second session did not receive a distinct id" >&2
        exit 50
    fi
    assert_body_contains "$SESSION_B" "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_B}/state?cwd=${WORKSPACE_Q}"

    # A brand-new Pi session is intentionally in-memory until it records a
    # turn. Persist B before exercising B -> A -> B switching; otherwise the
    # test would incorrectly assume an abandoned blank session has a JSONL.
    FORK_SOURCE="$SESSION_A"
    DELETE_SESSION_B=false
    if [ -n "$SESSION_MODEL" ]; then
        SSE_B_BODY="$TEMP_DIR/session-b-sse.body"
        (curl --silent --show-error --no-buffer --max-time 130 \
            --output "$SSE_B_BODY" \
            "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_B}/events?cwd=${WORKSPACE_Q}" || true) &
        SSE_PID=$!
        sleep 0.2
        curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
            -d '{"message":"Reply with exactly NODE_NATIVE_SESSION_B_OK"}' \
            "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_B}/prompt?cwd=${WORKSPACE_Q}" >/dev/null
        if ! wait_for_file_match "$SSE_B_BODY" '"type":"(session\.idle|error)"' 1200; then
            echo "session B prompt did not produce a terminal Node SSE event" >&2
            sed -n '1,160p' "$SSE_B_BODY" >&2 || true
            exit 50
        fi
        kill "$SSE_PID" 2>/dev/null || true
        wait "$SSE_PID" 2>/dev/null || true
        SSE_PID=""
        assert_body_contains "$SESSION_A" "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_A}/state?cwd=${WORKSPACE_Q}"
        assert_body_contains "$SESSION_B" "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_B}/state?cwd=${WORKSPACE_Q}"
        FORK_SOURCE="$SESSION_B"
        DELETE_SESSION_B=true
    else
        # Still verify the required A -> B -> A transition. Blank B is
        # ephemeral by Pi design and disappears once A is resumed.
        assert_body_contains "$SESSION_A" "http://127.0.0.1:${NODE_PORT}/api/sessions/${SESSION_A}/state?cwd=${WORKSPACE_Q}"
    fi

    FORK_HEADERS="$TEMP_DIR/fork.headers"
    FORK_JSON="$(curl --fail --silent --show-error --dump-header "$FORK_HEADERS" -X POST \
        -H 'Content-Type: application/json' -d '{}' \
        "http://127.0.0.1:${NODE_PORT}/api/sessions/${FORK_SOURCE}/fork?cwd=${WORKSPACE_Q}")"
    FORK_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("id", ""))' "$FORK_JSON")"
    assert_header_file_contains "$FORK_HEADERS" 'x-pi-science-runtime: node-control-plane'
    if [ -z "$FORK_ID" ] || [ "$FORK_ID" = "$FORK_SOURCE" ]; then
        echo "fork did not return a distinct session: $FORK_JSON" >&2
        exit 50
    fi

    HEALTH_ACTIVE_JSON="$(curl --fail --silent --show-error "http://127.0.0.1:${NODE_PORT}/api/health")"
    python3 -c 'import json,sys; value=json.loads(sys.argv[1])["active_pi_processes"]; assert value >= 1, value' "$HEALTH_ACTIVE_JSON"

    echo "[smoke] exact delete and health ownership"
    DELETE_IDS=("$FORK_ID")
    if [ "$DELETE_SESSION_B" = true ]; then DELETE_IDS+=("$SESSION_B"); fi
    DELETE_IDS+=("$SESSION_A")
    for session_id in "${DELETE_IDS[@]}"; do
        DELETE_HEADERS="$TEMP_DIR/delete-${session_id}.headers"
        DELETE_JSON="$(curl --fail --silent --show-error --dump-header "$DELETE_HEADERS" -X DELETE \
            "http://127.0.0.1:${NODE_PORT}/api/sessions/${session_id}?cwd=${WORKSPACE_Q}")"
        assert_header_file_contains "$DELETE_HEADERS" 'x-pi-science-runtime: node-control-plane'
        if ! echo "$DELETE_JSON" | grep -q '"ok":true'; then
            echo "delete failed for $session_id: $DELETE_JSON" >&2
            exit 50
        fi
    done
    assert_status 404 "http://127.0.0.1:${NODE_PORT}/api/sessions/${FORK_ID}/state?cwd=${WORKSPACE_Q}"
    HEALTH_FINAL_HEADERS="$TEMP_DIR/health-final.headers"
    HEALTH_FINAL_JSON="$(curl --fail --silent --show-error --dump-header "$HEALTH_FINAL_HEADERS" \
        "http://127.0.0.1:${NODE_PORT}/api/health")"
    assert_header_file_contains "$HEALTH_FINAL_HEADERS" 'x-pi-science-runtime: node-control-plane'
    python3 -c 'import json,sys; value=json.loads(sys.argv[1])["active_pi_processes"]; assert value == 0, value' "$HEALTH_FINAL_JSON"
fi

echo "[smoke] passed"
