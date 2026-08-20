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
  echo "Error: Node.js >=22.12.0 is required." >&2
  exit 1
fi
NODE_PATH="$(node -p 'process.execPath')"
if ! "$NODE_PATH" "$SCRIPT_DIR/check-node-version.mjs"; then
  echo "Error: Node.js >=22.12.0 is required (found $("$NODE_PATH" --version))." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required. Enable it with: corepack enable pnpm" >&2
  exit 1
fi

echo "  Node.js: $("$NODE_PATH" --version)"
echo "  pnpm:   $(pnpm --version)"

if [ -n "${PI_CLI_PATH:-}" ]; then
  PI_CLI="$PI_CLI_PATH"
  [ -f "$PI_CLI" ] || { echo "Error: PI_CLI_PATH does not point to a file: $PI_CLI" >&2; exit 1; }
else
  echo "==> Installing Pi agent runtime..."
  bash "$SCRIPT_DIR/fetch-pi.sh"
  PI_CLI_MARKER="$RUNTIME_DIR/.cli-path"
  PI_DEV_MARKER="$RUNTIME_DIR/.dev-repo-path"
  if [ -f "$PI_CLI_MARKER" ]; then
    PI_CLI="$(cat "$PI_CLI_MARKER")"
  elif [ -f "$PI_DEV_MARKER" ]; then
    PI_REPO_PATH="$(cat "$PI_DEV_MARKER")"
    PI_CLI="$PI_REPO_PATH/packages/coding-agent/src/cli.ts"
  else
    PI_CLI="$RUNTIME_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  fi
  [ -f "$PI_CLI" ] || { echo "Error: Pi installer did not produce a CLI at: $PI_CLI" >&2; exit 1; }
fi

echo "==> Installing JavaScript workspace dependencies..."
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$PROJECT_DIR/.cache/pnpm-store}"
mkdir -p "$PNPM_STORE_DIR"
cd "$PROJECT_DIR"
pnpm --config.store-dir="$PNPM_STORE_DIR" install --frozen-lockfile

mkdir -p "$INSTALL_STATE_DIR"
printf 'PI_SCIENCE_INSTALL_PI_CLI=%q\n' "$PI_CLI" > "$INSTALL_STATE_FILE"

# Put a `pi-science` command on PATH without following or replacing unrelated
# files and symlinks. The helper writes through a same-directory temp file.
BIN_DIR="${PI_SCIENCE_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/pi-science"
bash "$SCRIPT_DIR/write-launcher.sh" "$PROJECT_DIR" "$BIN_DIR"

echo "==> Installation complete."
echo "  Pi CLI:   $PI_CLI"
echo "  Launcher: $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  Start it with: pi-science" ;;
  *) echo "  Warning: $BIN_DIR is not on your PATH. Add it, or start with: bash scripts/start.sh"
     echo "           export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
