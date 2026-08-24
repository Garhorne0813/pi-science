#!/usr/bin/env bash
# Shared Node.js runtime selection for the installer and launchers.
# shellcheck shell=bash

NODE_RUNTIME_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_SCIENCE_NODE_CHECK_SCRIPT="$NODE_RUNTIME_SCRIPT_DIR/check-node-version.mjs"

pi_science_node_is_supported() {
  local node_command="${1:-}"
  [ -n "$node_command" ] && [ -x "$node_command" ] && "$node_command" "$PI_SCIENCE_NODE_CHECK_SCRIPT" >/dev/null 2>&1
}

pi_science_source_nvm() {
  local nvm_dir="${NVM_DIR:-${HOME:-}/.nvm}"
  [ -s "$nvm_dir/nvm.sh" ] || return 1
  export NVM_DIR="$nvm_dir"
  # nvm.sh is not nounset-safe on every supported nvm release.
  set +u
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  set -u
  command -v nvm >/dev/null 2>&1
}

pi_science_use_node_command() {
  local node_command="${1:-}"
  pi_science_node_is_supported "$node_command" || return 1
  export PI_SCIENCE_NODE_COMMAND="$node_command"
  export PATH="$(dirname "$node_command"):$PATH"
}

# Select a supported Node.js for the current shell process.
#
# The installer may install the minimum supported Node through nvm when the
# nvm-managed version is missing. Starting the app never installs software;
# it only selects an already-installed version and prints an actionable error.
pi_science_prepare_node() {
  local install_missing="${1:-0}" current="$(command -v node || true)" nvm_version="" candidate
  if pi_science_use_node_command "$current"; then return 0; fi

  if ! command -v nvm >/dev/null 2>&1; then pi_science_source_nvm || true; fi
  if command -v nvm >/dev/null 2>&1; then
    nvm_version="$(nvm version 24 2>/dev/null || true)"
    if [ -n "$nvm_version" ] && [ "$nvm_version" != "N/A" ]; then
      nvm use --silent 24 >/dev/null 2>&1 || true
      current="$(command -v node || true)"
      if pi_science_use_node_command "$current"; then return 0; fi
    fi
    if [ "$install_missing" = "1" ]; then
      echo "  Node.js 24.16.0+ not found; installing it through nvm..." >&2
      nvm install 24.16.0 >/dev/null
      nvm use --silent 24.16.0 >/dev/null 2>&1
      current="$(command -v node || true)"
      if pi_science_use_node_command "$current"; then return 0; fi
    fi
  fi

  # Also support an installed but unlinked Homebrew/Node version without
  # changing the user's global shell configuration.
  for candidate in \
    "${NVM_DIR:-${HOME:-}/.nvm}"/versions/node/v24*/bin/node \
    /opt/homebrew/opt/node@24/bin/node \
    /usr/local/opt/node@24/bin/node; do
    if pi_science_use_node_command "$candidate"; then return 0; fi
  done
  return 1
}

pi_science_node_error() {
  local found="$(command -v node || true)" version="none"
  if [ -n "$found" ]; then version="$("$found" --version 2>/dev/null || printf 'unknown')"; fi
  echo "Error: Node.js >=24.16.0 is required (found $version)." >&2
  echo "Install or activate it with: nvm install 24.16.0 && nvm use 24.16.0" >&2
}
