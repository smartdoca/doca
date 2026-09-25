#!/usr/bin/env bash
set -euo pipefail
exec "$(cd "$(dirname "$0")/../../doca-mail/scripts" && pwd)/setup-mail.sh" "$@"
