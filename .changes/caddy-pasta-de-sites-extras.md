---
impacto: capacidade_nova
secao: adicionado
titulo: O Caddy do kit serve outros sites pela pasta sites/, sem mexer no Caddyfile
---

Quem usa o Caddy do kit (`REVERSE_PROXY=caddy`) pode servir outro site no mesmo servidor gravando um arquivo `sites/<nome>.caddy` ao lado do `docker-compose.prod.yml`. O Caddyfile importa todo `*.caddy` dessa pasta, que fica fora do git: nenhuma atualização encosta no que está nela, ao contrário de um bloco escrito à mão no Caddyfile. Antes de recarregar, confira com `docker compose -f docker-compose.prod.yml exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`, porque um arquivo quebrado na pasta impede o Caddy de subir no próximo reinício. A atualização cria a pasta vazia e nada mais muda. Com o Traefik ou o Nginx Proxy Manager da hospedagem, a pasta não é usada.
