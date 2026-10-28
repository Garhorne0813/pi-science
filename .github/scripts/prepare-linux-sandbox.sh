#!/usr/bin/env bash
# Only for disposable GitHub-hosted Ubuntu runners, never application startup.
set -euo pipefail
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || ${RUNNER_OS:-} != Linux ]]; then
  echo 'Sandbox CI preparation requires a disposable GitHub-hosted Linux runner.' >&2
  exit 1
fi
sudo apt-get update
sudo apt-get install -y bubblewrap socat ripgrep
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# Ubuntu's bwrap profile separately denies capabilities to child processes.
# The seccomp helper needs a nested user/PID/mount namespace; allowing only the
# outer bwrap userns does not suffice. Unload just that profile for this job.
# https://github.com/anthropics/sandbox-runtime/issues/429
for profile in /etc/apparmor.d/bwrap /etc/apparmor.d/bwrap-userns-restrict; do
  if [[ -f $profile ]]; then
    sudo apparmor_parser -R "$profile"
  fi
done
