#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/project"
export ARGS_LOG="$WORK/args" HEADER_LOG="$WORK/header"
cat > "$WORK/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$ARGS_LOG"
cat > "$HEADER_LOG"
printf '{}\n200'
CURL
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"
printf 'NEXT_PUBLIC_APP_URL=https://crm.example.invalid\nINTERNAL_SECRET=synthetic-test-secret\n' > "$WORK/project/.env"
touch "$WORK/project/docker-compose.prod.yml"
cd "$WORK/project"
bash "$ROOT/hostgator-setup-kit/event-log-drain.sh"
! grep -q synthetic-test-secret "$ARGS_LOG"
grep -q 'Authorization: Bearer synthetic-test-secret' "$HEADER_LOG"
sed -n '/^post() {/,/^}/p' "$ROOT/hostgator-setup-kit/agent.sh" > "$WORK/post.sh"
source "$WORK/post.sh"
SECRET=synthetic-test-secret API=https://crm.example.invalid/agent ERRLOG="$WORK/error"
log_err() { return 1; }
post '{}' >/dev/null
! grep -q synthetic-test-secret "$ARGS_LOG"
grep -q 'Authorization: Bearer synthetic-test-secret' "$HEADER_LOG"
echo 'drain and updater authenticate through stdin without bearer in argv'
