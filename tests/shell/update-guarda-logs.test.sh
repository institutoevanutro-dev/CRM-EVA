#!/usr/bin/env bash
# Os logs da versão que sai sobrevivem ao `up -d` da atualização.
#
#   bash tests/shell/update-guarda-logs.test.sh
#
# Medido em 14/10/2026: três "Erro interno" na Agenda minutos antes de uma
# atualização; o `fail()` anotou a causa de cada um e o `up -d` apagou a
# anotação junto com o contêiner. Sem rede e sem Docker (`docker` é dublê).
# Prova: o arquivo nasce com o log dos três serviços, legível só pelo dono;
# só as 5 atualizações mais recentes ficam; e `docker` falhando não derruba
# quem chamou, que roda com `set -e`.
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hostgator-setup-kit" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILS=0
check() {  # check <descrição> <comando...>
  if "${@:2}"; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); fi
}

mkdir -p "$WORK/bin" "$WORK/proj/logs"
cat > "$WORK/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WORK/docker.log"
[ -e "$WORK/quebrado" ] && exit 1
printf 'app-1 | {"msg":"api.internal_error","requestId":"6a07bbf3"}\n'
STUB
chmod +x "$WORK/bin/docker"

# Seis guardas antigos: depois da chamada só podem sobrar 5 no total.
for i in 1 2 3 4 5 6; do
  touch -t "20261001000$i" "$WORK/proj/logs/antes-da-atualizacao-2026100${i}-000000.log"
done

rodar() {
  PATH="$WORK/bin:$PATH" PROJECT_DIR="$WORK/proj" bash -c \
    'set -euo pipefail; source "$1/_common.sh"; guardar_logs_antes_de_trocar; echo seguiu' _ "$KIT_DIR"
}

saida="$(rodar)"
novo="$(ls -1t "$WORK/proj/logs"/antes-da-atualizacao-*.log | head -1)"

check "pede os logs de app, worker e scheduler" grep -q "logs --no-color --timestamps --since 48h app worker scheduler" "$WORK/docker.log"
check "o arquivo novo guarda o log" grep -q "api.internal_error" "$novo"
check "o arquivo nasce 600" test "$(stat -c %a "$novo" 2>/dev/null || stat -f %Lp "$novo")" = "600"
check "só ficam as 5 mais recentes" test "$(ls "$WORK/proj/logs" | wc -l | tr -d ' ')" = "5"
check "o mais antigo foi o apagado" test ! -e "$WORK/proj/logs/antes-da-atualizacao-20261001-000000.log"
check "quem chamou seguiu" test "$saida" = "seguiu"

touch "$WORK/quebrado"
check "docker falhando não derruba a atualização (set -e)" test "$(rodar)" = "seguiu"

rm -rf "$WORK/proj/logs"; rm -f "$WORK/quebrado"
check "primeira atualização, sem pasta de logs: cria e segue" test "$(rodar)" = "seguiu"

[ "$FAILS" -eq 0 ] && echo "ok" || { echo "$FAILS falha(s)"; exit 1; }
