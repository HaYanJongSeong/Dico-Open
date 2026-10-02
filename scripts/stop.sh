#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

if is_bootstrapped; then
  launchctl bootout "${LAUNCHCTL_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  printf 'Stopped %s\n' "${SERVICE_LABEL}"
else
  printf '%s is not loaded.\n' "${SERVICE_LABEL}"
fi
