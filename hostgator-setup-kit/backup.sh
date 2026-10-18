#!/usr/bin/env bash
# Backup: dump do banco (Supabase) + snapshot das sessões do WhatsApp.
# Supabase free NÃO tem backup automático — rode isto num cron diário.
#
#   crontab -e →  0 3 * * *  cd /caminho/deskcommcrm && bash hostgator-setup-kit/backup.sh
source "$(dirname "$0")/_common.sh"
enter_project

BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
mkdir -p "$BACKUP_DIR"
# Timestamp vem do host (não do script) pra manter determinismo do kit.
ts="$(date +%Y%m%d-%H%M%S)"

step "Dump do banco → $BACKUP_DIR/db-$ts.sql.gz"
# Pela conexão de SCHEMA (url_do_schema), não pela do app: `pg_dump` só despeja
# o que a role enxerga, e com uma role menor — a que recomendamos no `.env` de
# quem usa Supabase próprio — o backup sai PARCIAL e sai verde. Falha silenciosa
# de backup é a pior das falhas: só aparece na hora de restaurar.
#
# `--exclude-table-data=private.app_secrets`: a chave de cifra NÃO vai no mesmo
# arquivo que os segredos cifrados com ela — quem leva o backup levaria os dois.
# Ela vive no `.env`, e o `restore.sh` a semeia de volta. `umask 077`: o dump
# tem dado de paciente e nasce legível só pelo dono.
( umask 077
  docker run --rm postgres:17-alpine pg_dump "$(url_do_schema)" --no-owner --no-privileges \
    --exclude-table-data=private.app_secrets \
    | gzip > "$BACKUP_DIR/db-$ts.sql.gz" )
chmod 600 "$BACKUP_DIR/db-$ts.sql.gz"
c_grn "✓ banco: $(du -h "$BACKUP_DIR/db-$ts.sql.gz" | awk '{print $1}')"

step "Snapshot das sessões do WhatsApp → $BACKUP_DIR/waha-$ts.tgz"
# Nome real do volume (não o curto `waha-data`) — ver volume_waha_do_projeto.
waha_ok=1
vol="$(volume_waha_do_projeto)"
arq="$BACKUP_DIR/waha-$ts.tgz"
if ! docker volume inspect "$vol" >/dev/null 2>&1; then
  waha_ok=0
  c_red "✖ volume '$vol' não existe — sessões do WhatsApp NÃO foram salvas."
  c_ylw "  Confira com: docker volume ls | grep waha-data"
else
  ( umask 077
    docker run --rm -v "${vol}:/data:ro" -v "$BACKUP_DIR:/out" alpine:3.20 \
      sh -c 'umask 077; exec tar czf "$1" -C /data .' sh "/out/waha-$ts.tgz" ) || true
  chmod 600 "$arq" 2>/dev/null || true
  # Arquivo vazio não é backup: apagá-lo impede que a retenção troque um
  # snapshot bom por ele.
  if [ "$(tar tzf "$arq" 2>/dev/null | grep -cv '/$' || true)" -eq 0 ]; then
    waha_ok=0
    rm -f "$arq"
    c_red "✖ snapshot das sessões saiu VAZIO (volume '$vol') — descartado."
  else
    c_grn "✓ sessões WhatsApp ($vol): $(du -h "$arq" | awk '{print $1}')"
  fi
fi
if [ "$waha_ok" = 0 ] && [ "$vol" != waha-data ] && docker volume inspect waha-data >/dev/null 2>&1; then
  c_dim "  Há um volume solto 'waha-data' (criado por versão antiga deste script)."
  c_dim "  Se estiver vazio, pode removê-lo: docker volume rm waha-data"
fi

# Retenção: mantém os 14 mais recentes de cada tipo.
step "Limpando backups antigos (mantém 14)"
(ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
(ls -1t "$BACKUP_DIR"/waha-*.tgz 2>/dev/null || true) | tail -n +15 | xargs -r rm -f 2>/dev/null || true
# Saída 3 = banco salvo, sessões não. O cron vê falha; o update.sh, que só
# mexe no banco, segue com aviso em vez de travar toda atualização.
[ "$waha_ok" = 1 ] || { c_red "✖ backup INCOMPLETO: banco salvo, sessões do WhatsApp não (ver acima)."; exit 3; }
c_grn "✓ backup concluído em $BACKUP_DIR"
