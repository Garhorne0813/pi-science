#!/usr/bin/env bash
# dev.sh — install dependencies if needed, then start Pi-Science.
# Usage: bash scripts/dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "${PI_SCIENCE_SKIP_INSTALL:-0}" != "1" ]; then
  bash "$SCRIPT_DIR/install.sh"
fi

exec bash "$SCRIPT_DIR/start.sh"
