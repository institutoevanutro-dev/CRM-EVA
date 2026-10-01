#!/usr/bin/env bash
# B5 da auditoria de 2026-09-29 — o backup guardava a chave de cifra
# (`private.app_secrets`) no MESMO arquivo que o CPF/segredos cifrados com ela,
# e o arquivo nascia legível por qualquer usuário do host.
#
#   bash tests/shell/backup-sem-chave-de-cifra.test.sh
#
# Prova três coisas, sem rede e sem Postgres (`docker` é dublê):
#   1. `pg_dump` roda com `--exclude-table-data=private.app_secrets`;
#   2. o dump nasce `600`;
#   3. o `restore.sh` volta a semear a chave a partir do `.env` — sem isso o
#      banco restaurado não decifra nada — e NÃO inventa chave nova quando o
#      `.env` não tem uma (chave nova tornaria o que foi cifrado ilegível).
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

mkdir -p "$WORK/bin" "$WORK/proj"
cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/docker.log"
case "\$*" in
  *pg_dump*) printf -- '-- dump\n' ;;
  *psql*) cat > "$WORK/psql-\$(date +%s%N).in" ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

cd "$WORK/proj"
touch docker-compose.prod.yml
cat > .env <<'ENV'
SUPABASE_DB_URL=postgresql://u:p@db:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://db.exemplo
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=abc123
ENV

echo "backup.sh"
BACKUP_DIR="$WORK/bk" bash "$KIT_DIR/backup.sh" >/dev/null 2>&1
dump="$(ls "$WORK"/bk/db-*.sql.gz 2>/dev/null | head -1)"
check "gera o dump" test -n "$dump"
check "pg_dump exclui os dados de private.app_secrets" \
  grep -q -- "--exclude-table-data=private.app_secrets" "$WORK/docker.log"
modo="$(stat -c %a "$dump" 2>/dev/null || stat -f %Lp "$dump" 2>/dev/null)"
check "dump nasce 600 (era $modo)" test "$modo" = "600"

echo "restore.sh"
: > "$WORK/docker.log"; rm -f "$WORK"/psql-*.in
printf 'RESTAURAR\n' | bash "$KIT_DIR/restore.sh" "$dump" >/dev/null 2>&1
check "reaplica a chave do .env em private.app_secrets" \
  grep -qs "insert into private.app_secrets.*abc123" "$WORK/docker.log" "$WORK"/psql-*.in

: > "$WORK/docker.log"; rm -f "$WORK"/psql-*.in
sed -i.bak '/NUVEMSHOP_OAUTH_ENCRYPTION_KEY/d' .env
printf 'RESTAURAR\n' | bash "$KIT_DIR/restore.sh" "$dump" >/dev/null 2>&1
check "sem chave no .env não inventa uma nova" \
  bash -c "! grep -q NUVEMSHOP_OAUTH_ENCRYPTION_KEY '$WORK/proj/.env' && ! grep -qs 'app_secrets' '$WORK/docker.log'"

[ "$FAILS" -eq 0 ] && echo "OK" || { echo "$FAILS falha(s)"; exit 1; }
