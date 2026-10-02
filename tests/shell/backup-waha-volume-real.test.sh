#!/usr/bin/env bash
# Bug de 2026-10-01 (VPS de produção): o backup.sh tirava o nome do volume de
# `docker compose config --volumes`, que imprime o nome CURTO (`waha-data`). O
# `docker run -v waha-data:/data` criava um volume vazio com esse nome, o tar
# arquivava um diretório vazio (87 bytes) e o script dizia "✓".
#
#   bash tests/shell/backup-waha-volume-real.test.sh
#
# `docker` é dublê: os volumes são diretórios em $WORK/vols, e `docker run -v`
# com volume inexistente o CRIA vazio — como o docker de verdade.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

mkdir -p "$WORK/bin" "$WORK/proj" "$WORK/vols"
cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/docker.log"
V="$WORK/vols"
case "\$1 \$2" in
  "ps "*) [ -f "$WORK/ctr" ] && echo abc123 ;;
  "inspect "*) cat "$WORK/ctr" ;;
  "volume inspect") [ -d "\$V/\$3" ] ;;
  "run "*)
    case "\$*" in
      *pg_dump*) printf -- '-- dump\n' ;;
      *tar*)
        vol="\$(printf '%s\n' "\$@" | grep ':/data:ro' | cut -d: -f1)"
        out="\$(printf '%s\n' "\$@" | grep ':/out\$' | cut -d: -f1)"
        mkdir -p "\$V/\$vol"
        tar czf "\$out/\$(basename "\$(printf '%s\n' "\$@" | grep '^/out/')")" -C "\$V/\$vol" . ;;
    esac ;;
esac
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

cd "$WORK/proj"
touch docker-compose.prod.yml
printf 'SUPABASE_DB_URL=postgresql://u:p@db:5432/postgres\nCOMPOSE_PROJECT_NAME=deskcommcrm\n' > .env

roda() {  # roda → status do backup.sh; zera backups e log
  rm -rf "$WORK/bk"; : > "$WORK/docker.log"
  BACKUP_DIR="$WORK/bk" bash "$KIT_DIR/backup.sh" > "$WORK/out.log" 2>&1
}
arquivo() { ls "$WORK"/bk/waha-*.tgz 2>/dev/null | head -1; }

echo "volume do contêiner WAHA (nome real, não o curto)"
mkdir -p "$WORK/vols/deskcommcrm_waha-data/default"
echo creds > "$WORK/vols/deskcommcrm_waha-data/default/creds.json"
echo deskcommcrm_waha-data > "$WORK/ctr"
roda; st=$?
check "sai 0" test "$st" -eq 0
check "monta o volume real" grep -q -- "-v deskcommcrm_waha-data:/data:ro" "$WORK/docker.log"
check "não cria o volume curto 'waha-data'" test ! -d "$WORK/vols/waha-data"
check "arquivo tem as sessões" bash -c "tar tzf '$(arquivo)' | grep -q creds.json"
modo="$(stat -c %a "$(arquivo)" 2>/dev/null || stat -f %Lp "$(arquivo)" 2>/dev/null)"
check "arquivo final 600 (era $modo)" test "$modo" = "600"
# O Docker não herda umask do host. Executa o comando REAL do container sob
# 022, trocando só o tar por um dublê que observa a máscara antes da escrita.
container_command="$(sed -n "s/.*sh -c '\(.*\)' sh .*/\1/p" "$KIT_DIR/backup.sh")"
cat > "$WORK/bin/tar-probe" <<'PROBE'
#!/usr/bin/env sh
umask
PROBE
chmod +x "$WORK/bin/tar-probe"
container_command="${container_command/exec tar/exec tar-probe}"
mask="$(umask 022; sh -c "$container_command" sh /out/test.tgz)"
check "container restringe permissão ANTES de criar o arquivo" test "$mask" = "0077"


echo "sem contêiner no ar → <projeto>_waha-data"
rm -f "$WORK/ctr"
roda; st=$?
check "sai 0 pelo fallback" test "$st" -eq 0
check "usa deskcommcrm_waha-data" grep -q -- "-v deskcommcrm_waha-data:/data:ro" "$WORK/docker.log"

echo "volume inexistente → falha alto, sem criar volume"
echo outro_waha-data > "$WORK/ctr"
roda; st=$?
check "sai 3 (banco salvo, sessões não)" test "$st" -eq 3
check "não chama docker run com o volume" bash -c "! grep -q 'outro_waha-data:/data' '$WORK/docker.log'"
check "não cria o volume" test ! -d "$WORK/vols/outro_waha-data"
check "diz que não salvou" grep -q "NÃO foram salvas" "$WORK/out.log"
check "não deixa arquivo" test -z "$(arquivo)"

echo "volume vazio → falha alto e descarta o arquivo"
mkdir -p "$WORK/vols/vazio_waha-data"
echo vazio_waha-data > "$WORK/ctr"
mkdir -p "$WORK/vols/waha-data"   # o volume solto que a versão antiga criou
roda; st=$?
check "sai 3 (banco salvo, sessões não)" test "$st" -eq 3
check "descarta o arquivo vazio" test -z "$(arquivo)"
check "avisa do volume solto sem apagá-lo" bash -c "grep -q 'docker volume rm waha-data' '$WORK/out.log' && ! grep -q 'volume rm' '$WORK/docker.log'"

echo "update.sh: snapshot das sessões falhou (saída 3) não trava a atualização"
check "update.sh trata a saída 3 como aviso" \
  grep -q '"\$bk_rc" = 3' "$KIT_DIR/update.sh"

[ "$FAILS" -eq 0 ] && echo "OK" || { echo "$FAILS falha(s)"; exit 1; }
