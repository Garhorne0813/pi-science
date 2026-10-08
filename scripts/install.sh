#!/usr/bin/env bash
# install.sh — install project dependencies, including Agent Core.
# Usage: bash scripts/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_STATE_DIR="$PROJECT_DIR/.runtime/pi-science"
INSTALL_STATE_FILE="$INSTALL_STATE_DIR/install.env"

echo "==> Checking installation prerequisites..."
source "$SCRIPT_DIR/node-runtime.sh"
if ! pi_science_prepare_node 1; then
  pi_science_node_error
  exit 1
fi
NODE_PATH="$PI_SCIENCE_NODE_COMMAND"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is required. Enable it with: corepack enable pnpm" >&2
  exit 1
fi

echo "  Node.js: $("$NODE_PATH" --version)"
echo "  pnpm:   $(pnpm --version)"

echo "==> Installing JavaScript workspace dependencies..."
PNPM_STORE_DIR="${PNPM_STORE_DIR:-$PROJECT_DIR/.cache/pnpm-store}"
mkdir -p "$PNPM_STORE_DIR"
cd "$PROJECT_DIR"
pnpm --config.store-dir="$PNPM_STORE_DIR" install --frozen-lockfile

mkdir -p "$INSTALL_STATE_DIR"
printf 'PI_SCIENCE_INSTALL_RUNTIME=agent-core\n' > "$INSTALL_STATE_FILE"

# Put a `pi-science` command on PATH without following or replacing unrelated
# files and symlinks. The helper writes through a same-directory temp file.
BIN_DIR="${PI_SCIENCE_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/pi-science"
bash "$SCRIPT_DIR/write-launcher.sh" "$PROJECT_DIR" "$BIN_DIR"

echo "==> Installation complete."
echo "  Runtime:  Agent Core"
echo "  Launcher: $LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "  Start it with: pi-science" ;;
  *) echo "  Warning: $BIN_DIR is not on your PATH. Add it, or start with: bash scripts/start.sh"
     echo "           export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
