#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
mkdir -p .local/wildduck
if [[ ! -d .local/wildduck/node_modules/wildduck ]]; then
  (cd .local/wildduck && npm init -y >/dev/null && npm install wildduck@1.46.1 --omit=dev --registry=https://registry.npmmirror.com)
fi
docker compose -f compose.mail.yaml up -d
