#!/usr/bin/env bash
# Host prerequisites for disposable GitHub-hosted Linux VMs, never product startup.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_OS:-}" != Linux ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  echo "This setup is restricted to disposable GitHub-hosted Linux runners." >&2
  exit 1
fi

# Permit namespace creation on this test VM. The runtime still enforces its
# user/PID/network/mount namespaces, read-only binds and Unix-socket seccomp.
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# Ubuntu's bwrap profile stacks children into unpriv_bwrap, whose explicit
# capability deny prevents apply-seccomp from creating its nested namespaces.
# The sysctl above does not remove an already attached named AppArmor policy.
profile=/etc/apparmor.d/bwrap-userns-restrict
if [ -f "$profile" ] && sudo grep -Eq '^(bwrap|unpriv_bwrap) ' /sys/kernel/security/apparmor/profiles; then
  echo "Unloading the incompatible bwrap host profile on this disposable VM."
  sudo apparmor_parser -R "$profile"
fi
uname -a
bwrap --version
cat /proc/self/attr/current
