#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_macos
require_command launchctl

launchctl print "${LAUNCHCTL_TARGET}"
