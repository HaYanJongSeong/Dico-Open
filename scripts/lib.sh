
set -euo pipefail

SERVICE_LABEL="com.opencode.discord"
PLIST_PATH="${HOME}/Library/LaunchAgents/${SERVICE_LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
STDOUT_LOG="${LOG_DIR}/out.log"
STDERR_LOG="${LOG_DIR}/err.log"
RUN_SCRIPT="${SCRIPT_DIR}/run.sh"
LAUNCHD_ENTRYPOINT="${SCRIPT_DIR}/entrypoint.sh"
LAUNCHCTL_DOMAIN="gui/$(id -u)"
LAUNCHCTL_TARGET="${LAUNCHCTL_DOMAIN}/${SERVICE_LABEL}"

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    printf 'This service is macOS-only.\n' >&2
    exit 1
  fi
}

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "${command_name}" >&2
    exit 1
  fi
}

detect_login_shell() {
  if [[ -n "${SHELL:-}" && -x "${SHELL}" ]]; then
    printf '%s\n' "${SHELL}"
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}' || true
      ;;
    Linux)
      getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7 || true
      ;;
  esac
}

is_bootstrapped() {
  launchctl print "${LAUNCHCTL_TARGET}" >/dev/null 2>&1
}

bootout_if_loaded() {
  if is_bootstrapped; then
    launchctl bootout "${LAUNCHCTL_DOMAIN}" "${PLIST_PATH}" >/dev/null 2>&1 || true
  fi
}

stop_if_loaded() {
  if is_bootstrapped; then
    launchctl kill TERM "${LAUNCHCTL_TARGET}" >/dev/null 2>&1 || true
  fi
}
