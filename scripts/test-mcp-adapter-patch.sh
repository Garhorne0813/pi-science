#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTER_VERSION="2.18.0"
PI_RUNTIME_PEER_VERSION="0.85.1"
TYPEBOX_VERSION="1.3.28"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-science-mcp-adapter.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

npm install \
  --prefix "$TEST_ROOT" \
  --no-save \
  --no-package-lock \
  --omit=dev \
  "pi-mcp-adapter@$ADAPTER_VERSION" \
  "@earendil-works/pi-ai@$PI_RUNTIME_PEER_VERSION" \
  "@earendil-works/pi-tui@$PI_RUNTIME_PEER_VERSION" \
  "typebox@$TYPEBOX_VERSION"

ADAPTER_ROOT="$TEST_ROOT/node_modules/pi-mcp-adapter"
node "$SCRIPT_DIR/patch-mcp-adapter.mjs" "$ADAPTER_ROOT"

cd "$PROJECT_DIR"
PI_SCIENCE_TEST_MCP_ADAPTER_PATH="$ADAPTER_ROOT" \
  pnpm --filter @pi-science/server exec vitest run \
    src/mcp/adapter-policy.test.ts \
    src/mcp/runtime-fetch.test.ts
