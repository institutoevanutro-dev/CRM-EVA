---
impacto: nada_mudou
secao: corrigido
titulo: A dica "Suba com" do diagnóstico leva o arquivo do proxy desta instalação
---

Quando não achava o worker, o `diagnostico.sh` sugeria subir a stack só com o `docker-compose.prod.yml`. Numa
instalação com Traefik, Nginx Proxy Manager ou portaria, seguir a dica recriava o Caddy pedindo as portas 80 e
443 e tirava o site do ar. Agora a dica lê o `REVERSE_PROXY` do `.env` e inclui o arquivo do modo.
