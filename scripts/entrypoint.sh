set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

START_BOT_SCRIPT="${SCRIPT_DIR}/start.sh"

LOGIN_SHELL="$(detect_login_shell)"
if [[ -z "${LOGIN_SHELL}" || ! -x "${LOGIN_SHELL}" ]]; then
  LOGIN_SHELL="/bin/sh"
fi

printf 'Waiting for Discord connectivity...\n'
until /usr/bin/nc -z discord.com 443 >/dev/null 2>&1; do
  sleep 5
done
printf 'Discord connectivity ready.\n'

exec "${LOGIN_SHELL}" -lc "
  cd ${REPO_ROOT}
  if command -v nvm >/dev/null 2>&1 ; then
    nvm use
  fi
  if ! command -v opencode >/dev/null 2>&1 ; then
    echo 'Missing opencode CLI'
    exit 1
  fi
  if ! test -f dist/src/cli.js ; then
    echo 'Missing dist/src/cli.js. Run pnpm build first.'
    exit 1
  fi
  node dist/src/cli.js
"
