#!/usr/bin/env bash
# Install the Pi Orbit runtime into runtime/pi/. Release binaries are the default;
# set PI_ORBIT_REPO to opt into running a local source checkout.
set -euo pipefail

PI_ORBIT_VERSION="${PI_ORBIT_VERSION:-0.1.0}"
PI_ORBIT_RELEASE_REPO="${PI_ORBIT_RELEASE_REPO:-Garhorne0813/pi-orbit}"
RPIV_ASK_USER_QUESTION_VERSION="${RPIV_ASK_USER_QUESTION_VERSION:-2.3.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_DIR/runtime/pi"
CLI_MARKER="$RUNTIME_DIR/.cli-path"

mkdir -p "$RUNTIME_DIR"

install_rpiv_ask_user_question() {
  command -v npm >/dev/null 2>&1 || {
    echo "ERROR: npm is required to install @juicesharp/rpiv-ask-user-question." >&2
    exit 1
  }
  echo "==> Installing @juicesharp/rpiv-ask-user-question@$RPIV_ASK_USER_QUESTION_VERSION..."
  npm install \
    --prefix "$RUNTIME_DIR" \
    --no-save \
    --no-package-lock \
    --ignore-scripts \
    --omit=dev \
    "@juicesharp/rpiv-ask-user-question@$RPIV_ASK_USER_QUESTION_VERSION"
}

# Local source is an explicit development override. This avoids silently using
# a nearby checkout whose generated dist packages may be stale.
if [ -n "${PI_ORBIT_REPO:-}" ]; then
  LOCAL_PI_REPO="$PI_ORBIT_REPO"
  [ -f "$LOCAL_PI_REPO/packages/coding-agent/src/cli.ts" ] || {
    echo "ERROR: PI_ORBIT_REPO is not a Pi Orbit source checkout: $LOCAL_PI_REPO" >&2
    exit 1
  }
  [ -x "$LOCAL_PI_REPO/node_modules/.bin/tsx" ] || {
    echo "ERROR: Pi Orbit source dependencies are missing. Run npm install in: $LOCAL_PI_REPO" >&2
    exit 1
  }
  printf '%s\n' "$LOCAL_PI_REPO/packages/coding-agent/src/cli.ts" > "$CLI_MARKER"
  printf '%s\n' "$LOCAL_PI_REPO" > "$RUNTIME_DIR/.dev-repo-path"
  install_rpiv_ask_user_question
  echo "==> Pi Orbit dev runtime ready: $LOCAL_PI_REPO"
  exit 0
fi

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "ERROR: Pi Orbit release installation supports macOS and Linux from this script." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "ERROR: Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

archive="pi-orbit-${platform}-${arch}.tar.gz"
tag="pi-orbit-v${PI_ORBIT_VERSION}"
release_url="https://github.com/${PI_ORBIT_RELEASE_REPO}/releases/download/${tag}"
install_dir="$RUNTIME_DIR/releases/pi-orbit-$PI_ORBIT_VERSION"
pi_cli="$install_dir/pi-orbit/pi-orbit"

if [ ! -x "$pi_cli" ]; then
  download_dir="$(mktemp -d "$RUNTIME_DIR/.pi-orbit-download.XXXXXX")"
  trap 'rm -rf "$download_dir"' EXIT
  echo "==> Downloading Pi Orbit $PI_ORBIT_VERSION ($platform-$arch)..."
  curl --fail --location --silent --show-error -o "$download_dir/$archive" "$release_url/$archive"
  curl --fail --location --silent --show-error -o "$download_dir/SHA256SUMS" "$release_url/SHA256SUMS"

  # Parse SHA256SUMS without awk: the default awk on this machine is a broken
  # miniconda gawk (dyld libintl failure), so a plain shell loop is safer.
  expected=""
  while read -r hash_value name_entry; do
    name_entry="${name_entry#\*}"
    if [ "$name_entry" = "$archive" ]; then expected="$hash_value"; break; fi
  done < "$download_dir/SHA256SUMS"
  [ -n "$expected" ] || { echo "ERROR: $archive is missing from SHA256SUMS." >&2; exit 1; }
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$download_dir/$archive")"
    actual="${actual%% *}"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$download_dir/$archive")"
    actual="${actual%% *}"
  else
    echo "ERROR: shasum or sha256sum is required to verify Pi Orbit." >&2
    exit 1
  fi
  [ "$actual" = "$expected" ] || { echo "ERROR: SHA-256 verification failed for $archive." >&2; exit 1; }

  mkdir -p "$install_dir"
  tar -xzf "$download_dir/$archive" -C "$install_dir"
  chmod +x "$pi_cli"
fi

"$pi_cli" --help | grep -q -- '--web-app-managed' || {
  echo "ERROR: Installed Pi Orbit does not support app-managed Web Mode: $pi_cli" >&2
  exit 1
}
install_rpiv_ask_user_question
printf '%s\n' "$pi_cli" > "$CLI_MARKER"
echo "==> Pi Orbit $PI_ORBIT_VERSION ready: $pi_cli"
