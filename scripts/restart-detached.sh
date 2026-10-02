#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
LOG_PATH="${LOG_DIR}/restart-detached.log"

mkdir -p "${LOG_DIR}"

nohup bash -lc "cd \"${REPO_ROOT}\" && sleep 1 && pnpm service:restart" >>"${LOG_PATH}" 2>&1 &

printf 'Scheduled detached restart. Log: %s\n' "${LOG_PATH}"
