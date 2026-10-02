#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

bootout_if_loaded

if [[ -f "${PLIST_PATH}" ]]; then
  rm "${PLIST_PATH}"
  printf 'Removed %s\n' "${PLIST_PATH}"
else
  printf '%s was already removed.\n' "${PLIST_PATH}"
fi

printf 'Uninstalled %s\n' "${SERVICE_LABEL}"
