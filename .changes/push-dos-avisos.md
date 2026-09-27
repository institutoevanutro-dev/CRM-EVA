---
impacto: capacidade_nova
secao: adicionado
titulo: Os avisos que pedem gente chegam ao celular
---

Com o push ligado no aparelho (Configurações › Notificações), o aviso de que a
IA passou uma conversa para a equipe passa a chegar como notificação no
celular, mesmo com o CRM fechado. É o mesmo aviso que toca som com o site
aberto; o resto da Central continua só na tela. O texto sai no idioma da
organização, sem o nome nem o telefone do cliente, e o toque abre a conversa.
Precisa do par VAPID no `.env` (`VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`), como
o push de mensagem nova; sem ele, nada muda. Porte do DeskcommCRM original;
contribuição de @jmpo.
