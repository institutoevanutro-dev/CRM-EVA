#!/usr/bin/env bash
# Secrets travel on stdin, not in crontab or process arguments.
source "$(dirname "$0")/_common.sh"
enter_project
secret="${INTERNAL_CRON_SECRET:-${INTERNAL_SECRET:-}}"
[ -n "$secret" ] && [ -n "${NEXT_PUBLIC_APP_URL:-}" ] || exit 1
printf 'Authorization: Bearer %s\n' "$secret" |
  curl -fsS --max-time 55 -H @- "${NEXT_PUBLIC_APP_URL}/api/v1/cron/event-log-drain" >/dev/null
