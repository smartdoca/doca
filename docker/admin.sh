#!/usr/bin/env bash
set -euo pipefail
action="${1:-bootstrap}"
case "$action" in
  bootstrap) script=admin ;;
  reset-password) script=reset-admin-password ;;
  *) echo 'Usage: bash docker/admin.sh bootstrap|reset-password' >&2; exit 1 ;;
esac
read -r -p '管理员账号: ' login
[[ -n "$login" ]] || { echo '管理员账号不能为空' >&2; exit 1; }
read -r -s -p '管理员密码（至少 12 位）: ' password; echo
read -r -s -p '再次输入管理员密码: ' confirmation; echo
[[ "$password" == "$confirmation" && ${#password} -ge 12 ]] || { echo '密码不一致或少于 12 位' >&2; exit 1; }
if [[ "$action" == bootstrap ]]; then
  export DOCA_BOOTSTRAP_LOGIN="$login" DOCA_BOOTSTRAP_PASSWORD="$password"
else
  export DOCA_RESET_ADMIN_LOGIN="$login" DOCA_RESET_ADMIN_PASSWORD="$password"
fi
unset password confirmation
exec node --import tsx "apps/server/src/bootstrap/$script.ts"
