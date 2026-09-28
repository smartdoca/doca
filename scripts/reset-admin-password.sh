#!/usr/bin/env bash
set -euo pipefail

read -r -p "管理员账号: " DOCA_RESET_ADMIN_LOGIN
if [[ -z "${DOCA_RESET_ADMIN_LOGIN}" ]]; then
  echo "管理员账号不能为空" >&2
  exit 1
fi

read -r -s -p "新密码（至少 12 位）: " DOCA_RESET_ADMIN_PASSWORD
echo
read -r -s -p "再次输入新密码: " DOCA_RESET_ADMIN_PASSWORD_CONFIRM
echo
if [[ "${DOCA_RESET_ADMIN_PASSWORD}" != "${DOCA_RESET_ADMIN_PASSWORD_CONFIRM}" ]]; then
  echo "两次输入的密码不一致" >&2
  exit 1
fi
if (( ${#DOCA_RESET_ADMIN_PASSWORD} < 12 )); then
  echo "管理员密码至少需要 12 位" >&2
  exit 1
fi

export DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD
trap 'unset DOCA_RESET_ADMIN_LOGIN DOCA_RESET_ADMIN_PASSWORD DOCA_RESET_ADMIN_PASSWORD_CONFIRM' EXIT
docker compose run --rm --no-deps \
  -e DOCA_RESET_ADMIN_LOGIN \
  -e DOCA_RESET_ADMIN_PASSWORD \
  doca node --import tsx apps/server/src/bootstrap/reset-admin-password.ts
