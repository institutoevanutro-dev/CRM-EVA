---
impacto: capacidade_nova
secao: adicionado
titulo: Várias instalações no mesmo servidor, atrás de uma portaria
---

Novo valor `REVERSE_PROXY=portaria`, para servidor que recebe mais de uma instalação. Uma portaria (nginx
L4) fica com as portas 80 e 443 e repassa cada conexão, ainda cifrada e com o IP de quem visita, ao Caddy
da instalação certa. Quem não usa o modo não muda nada: o padrão continua `caddy`.
