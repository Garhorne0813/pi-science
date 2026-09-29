#!/usr/bin/env bash
# Install the Pi runtime into runtime/pi/ from the pinned npm packages. Set
# PI_RUNTIME_REPO to opt into running a local source checkout instead.
set -euo pipefail

# Pinned versions live here only: a version bump is a single edit per package.
PI_RUNTIME_VERSION="${PI_RUNTIME_VERSION:-0.84.4}"
PI_MCP_ADAPTER_VERSION="${PI_MCP_ADAPTER_VERSION:-2.18.0}"
PI_SUBAGENTS_VERSION="${PI_SUBAGENTS_VERSION:-0.40.0}"
PI_WEB_ACCESS_VERSION="${PI_WEB_ACCESS_VERSION:-0.18.0}"
CONTEXT_MODE_VERSION="${CONTEXT_MODE_VERSION:-1.0.169}"
RPIV_ASK_USER_QUESTION_VERSION="${RPIV_ASK_USER_QUESTION_VERSION:-2.3.1}"
RPIV_TODO_VERSION="${RPIV_TODO_VERSION:-2.4.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_DIR/runtime/pi"
CLI_MARKER="$RUNTIME_DIR/.cli-path"
NPM_CACHE_DIR="$RUNTIME_DIR/.npm-cache"
RUNTIME_CLI="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"

mkdir -p "$RUNTIME_DIR"

assert_installed_version() {
  local package_name="$1" expected="$2" actual
  actual="$(node -p "require(process.argv[1]).version" \
    "$RUNTIME_DIR/node_modules/$package_name/package.json" 2>/dev/null || true)"
  [ "$actual" = "$expected" ] || {
    echo "ERROR: $package_name $actual was installed instead of the pinned $expected." >&2
    exit 1
  }
}

assert_pinned_versions() {
  assert_installed_version "@earendil-works/pi-coding-agent" "$PI_RUNTIME_VERSION"
  assert_installed_version "@earendil-works/pi-agent-core" "$PI_RUNTIME_VERSION"
  assert_installed_version "pi-mcp-adapter" "$PI_MCP_ADAPTER_VERSION"
  assert_installed_version "pi-subagents" "$PI_SUBAGENTS_VERSION"
  assert_installed_version "pi-web-access" "$PI_WEB_ACCESS_VERSION"
  assert_installed_version "context-mode" "$CONTEXT_MODE_VERSION"
  assert_installed_version "@juicesharp/rpiv-ask-user-question" "$RPIV_ASK_USER_QUESTION_VERSION"
  assert_installed_version "@juicesharp/rpiv-todo" "$RPIV_TODO_VERSION"
}

# The runtime and its extensions go into a single npm invocation: npm reifies
# the whole runtime/pi prefix on every install, so a second `npm install
# --no-save` into the same prefix evicts the packages of the first one.
install_pi_runtime() {
  command -v npm >/dev/null 2>&1 || {
    echo "ERROR: npm is required to install the Pi runtime and its extensions." >&2
    exit 1
  }
  # A manifest left by an older install carries ranges (^0.80.6, ^2.16.0) that
  # npm re-resolves instead of keeping the pins below, so drop it first.
  rm -f "$RUNTIME_DIR/package.json" "$RUNTIME_DIR/package-lock.json"
  echo "==> Installing pi-runtime $PI_RUNTIME_VERSION and its extensions..."
  npm install \
    --prefix "$RUNTIME_DIR" \
    --no-save \
    --no-package-lock \
    --omit=dev \
    --cache "$NPM_CACHE_DIR" \
    "@earendil-works/pi-coding-agent@$PI_RUNTIME_VERSION" \
    "@earendil-works/pi-agent-core@$PI_RUNTIME_VERSION" \
    "pi-mcp-adapter@$PI_MCP_ADAPTER_VERSION" \
    "pi-subagents@$PI_SUBAGENTS_VERSION" \
    "pi-web-access@$PI_WEB_ACCESS_VERSION" \
    "context-mode@$CONTEXT_MODE_VERSION" \
    "@juicesharp/rpiv-ask-user-question@$RPIV_ASK_USER_QUESTION_VERSION" \
    "@juicesharp/rpiv-todo@$RPIV_TODO_VERSION"
  # The MCP adapter patches must land on the freshly installed adapter, so the
  # patch run stays the last write to the extension tree.
  node "$SCRIPT_DIR/patch-mcp-adapter.mjs"
  assert_pinned_versions
}

# Local source is an explicit development override. This avoids silently using
# a nearby checkout whose generated dist packages may be stale.
if [ -n "${PI_RUNTIME_REPO:-}" ]; then
  LOCAL_PI_REPO="$PI_RUNTIME_REPO"
  [ -f "$LOCAL_PI_REPO/packages/coding-agent/src/cli.ts" ] || {
    echo "ERROR: PI_RUNTIME_REPO is not a pi-runtime source checkout: $LOCAL_PI_REPO" >&2
    exit 1
  }
  [ -x "$LOCAL_PI_REPO/node_modules/.bin/tsx" ] || {
    echo "ERROR: pi-runtime source dependencies are missing. Run npm install in: $LOCAL_PI_REPO" >&2
    exit 1
  }
  printf '%s\n' "$LOCAL_PI_REPO/packages/coding-agent/src/cli.ts" > "$CLI_MARKER"
  printf '%s\n' "$LOCAL_PI_REPO" > "$RUNTIME_DIR/.dev-repo-path"
  install_pi_runtime
  echo "==> pi-runtime dev runtime ready: $LOCAL_PI_REPO"
  exit 0
fi

install_pi_runtime

[ -f "$RUNTIME_CLI" ] || {
  echo "ERROR: $RUNTIME_CLI was not produced by the pi-runtime npm install." >&2
  exit 1
}
node "$RUNTIME_CLI" --help >/dev/null || {
  echo "ERROR: Installed pi-runtime CLI did not answer --help: $RUNTIME_CLI" >&2
  exit 1
}

printf '%s\n' "$RUNTIME_CLI" > "$CLI_MARKER"
echo "==> pi-runtime $PI_RUNTIME_VERSION ready: $RUNTIME_CLI"
