#!/usr/bin/env bash
# Fetch/install the pi agent runtime into runtime/pi/.
# Like open-science's fetch-opencode.sh: the runtime never lives in git.
set -euo pipefail

PI_VERSION="${PI_VERSION:-0.80.6}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_DIR/runtime/pi"

mkdir -p "$RUNTIME_DIR"

# ── Strategy 1: Local pi repo (dev mode) ──
LOCAL_PI_REPO="$(dirname "$PROJECT_DIR")/pi"
if [ -d "$LOCAL_PI_REPO/packages/coding-agent/src" ]; then
  echo "==> pi (dev mode): running from source at $LOCAL_PI_REPO"

  cd "$LOCAL_PI_REPO"
  if [ ! -d "node_modules/.bin/tsx" ]; then
    echo "  Installing pi dependencies (npm install --ignore-scripts)..."
    npm install --ignore-scripts 2>&1 | tail -1
  fi

  # Install extensions (MCP adapter, subagents)
  for pkg in pi-mcp-adapter pi-subagents pi-web-access context-mode; do
    if [ ! -d "node_modules/$pkg" ]; then
      echo "  Installing $pkg..."
      npm install "$pkg" --save-dev --ignore-scripts 2>&1 | tail -1
    fi
  done

  # Output: path to pi repo root (config.py knows how to run from source)
  echo "$LOCAL_PI_REPO" > "$RUNTIME_DIR/.dev-repo-path"
  echo "==> pi dev mode ready (tsx from source)"
  exit 0
fi

# ── Strategy 2: npm install (production) ──
echo "==> Installing @earendil-works/pi-coding-agent@$PI_VERSION from npm..."
cd "$RUNTIME_DIR"
if [ ! -f "node_modules/.package-lock.json" ]; then
  npm init -y --silent 2>/dev/null
fi
npm install "@earendil-works/pi-coding-agent@$PI_VERSION" --ignore-scripts 2>&1 | tail -3

PI_INSTALLED="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
if [ -f "$PI_INSTALLED" ]; then
  ln -sf "$PI_INSTALLED" "$RUNTIME_DIR/cli.js" 2>/dev/null || true
  echo "==> pi $PI_VERSION installed from npm"
else
  echo "ERROR: Could not install pi."
  echo "  npm install @earendil-works/pi-coding-agent@$PI_VERSION"
  echo "  Or set PI_CLI_PATH env var."
  exit 1
fi
