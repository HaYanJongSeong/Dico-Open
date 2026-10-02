#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

if [[ ! -f "${PLIST_PATH}" ]]; then
  printf '%s is not loaded. Run pnpm service:setup first.\n' "${SERVICE_LABEL}" >&2
  exit 1
fi

bootout_if_loaded
launchctl bootstrap "${LAUNCHCTL_DOMAIN}" "${PLIST_PATH}"
launchctl kickstart -k "${LAUNCHCTL_TARGET}"
printf 'Restarted %s\n' "${SERVICE_LABEL}"
