#!/usr/bin/env bash
# Irmão do backup-waha-volume-real: o restore.sh tirava o nome do volume de
# `docker compose config --volumes`, que imprime o nome CURTO (`waha-data`). O
# `docker run -v waha-data:/data` criava um volume vazio com esse nome e
# devolvia as sessões a ele — o contêiner do WhatsApp, que monta
# `<projeto>_waha-data`, seguia sem nada, e o script dizia "✓".
#
#   bash tests/shell/restore-waha-volume-real.test.sh
#
# `docker` é dublê: os volumes são diretórios em $WORK/vols, e `docker run -v`
# com volume inexistente o CRIA — como o docker de verdade.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

mkdir -p "$WORK/bin" "$WORK/proj/backups" "$WORK/vols"
cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/docker.log"
V="$WORK/vols"
case "\$1" in
  compose) case "\$*" in *"config --volumes"*) echo waha-data ;; esac ;;
  ps) [ -f "$WORK/ctr" ] && echo abc123 ;;
  inspect) cat "$WORK/ctr" ;;
  run)
    case "\$*" in
      *psql*) cat > /dev/null ;;
      *tar*)
        vol="\$(printf '%s\n' "\$@" | grep ':/data\$' | cut -d: -f1)"
        in="\$(printf '%s\n' "\$@" | grep ':/in:ro\$' | cut -d: -f1)"
        cmd="\${!#}"; cmd="\${cmd//\/data/\$V/\$vol}"; cmd="\${cmd//\/in\//\$in/}"
        mkdir -p "\$V/\$vol"
        sh -c "\$cmd" ;;
    esac ;;
esac
STUB
chmod +x "$WORK/bin/docker"
PATH="$WORK/bin:$PATH"

cd "$WORK/proj"
touch docker-compose.prod.yml
printf 'SUPABASE_DB_URL=postgresql://u:p@db:5432/postgres\nNEXT_PUBLIC_SUPABASE_URL=http://db\nCOMPOSE_PROJECT_NAME=deskcommcrm\n' > .env
printf -- '-- dump\n' | gzip > backups/db-20261018-030000.sql.gz
mkdir -p "$WORK/snap/default"; echo creds > "$WORK/snap/default/creds.json"
tar czf backups/waha-20261018-030000.tgz -C "$WORK/snap" .

roda() {  # roda → status do restore.sh; zera volumes e log
  rm -rf "$WORK/vols"; mkdir -p "$WORK/vols/deskcommcrm_waha-data"
  echo antiga > "$WORK/vols/deskcommcrm_waha-data/velha.json"
  : > "$WORK/docker.log"
  echo RESTAURAR | bash "$KIT_DIR/restore.sh" backups/db-20261018-030000.sql.gz > "$WORK/out.log" 2>&1
}

echo "volume do contêiner WAHA (nome real, não o curto)"
echo deskcommcrm_waha-data > "$WORK/ctr"
roda; st=$?
check "sai 0" test "$st" -eq 0
check "monta o volume real" grep -q -- "-v deskcommcrm_waha-data:/data " "$WORK/docker.log"
check "não cria o volume curto 'waha-data'" test ! -d "$WORK/vols/waha-data"
check "sessões chegam ao volume real" test -f "$WORK/vols/deskcommcrm_waha-data/default/creds.json"
check "o que havia antes sai" test ! -f "$WORK/vols/deskcommcrm_waha-data/velha.json"

echo "sem contêiner no ar → <projeto>_waha-data"
rm -f "$WORK/ctr"
roda; st=$?
check "sai 0 pelo fallback" test "$st" -eq 0
check "sessões chegam a deskcommcrm_waha-data" test -f "$WORK/vols/deskcommcrm_waha-data/default/creds.json"
check "não cria o volume curto 'waha-data'" test ! -d "$WORK/vols/waha-data"

[ "$FAILS" -eq 0 ] && echo "OK" || { echo "$FAILS falha(s)"; exit 1; }
