#!/bin/bash
set -e
# The test supplies the prerequisite helper to exercise.
# shellcheck disable=SC1090
source "$1"
pi_science_check_linux_sandbox "$2"
if [ "${3:-}" = report ]; then
  "$2" -e 'console.log(JSON.stringify({rg:process.env.PI_SCIENCE_SANDBOX_RIPGREP,socat:process.env.PI_SCIENCE_SANDBOX_SOCAT,bwrap:process.env.PI_SCIENCE_SANDBOX_BWRAP}))'
fi
