---
impacto: nada_mudou
secao: corrigido
titulo: O follow-up de silêncio deixa de mandar mensagem por cima do retorno combinado
---

Quando o paciente pedia para ser procurado mais tarde, a IA agendava o retorno e
prometia voltar no horário combinado. O fluxo de silêncio não sabia desse retorno:
falava por cima dele enquanto estava agendado e, no minuto seguinte à mensagem do
retorno, inscrevia o contato de novo e mandava o primeiro passo logo em seguida.
Eram duas mensagens seguidas sem o paciente ter respondido.

Agora, enquanto há um retorno agendado ou que saiu há menos de um dia, o fluxo de
silêncio não inscreve o contato, e quem já estava no fluxo fica segurado até um dia
depois do retorno, com a linha "Segurou o fluxo por causa de um retorno agendado"
no histórico da inscrição. Se o paciente responder, vale o que o fluxo já fazia.
Nada muda para quem não tem retorno agendado, nem para os fluxos por etapa, por
caso, por falta ou manuais.

Porte do DeskcommCRM original: parte de retorno do commit b94446a5c (jmpo) e o
PR #2929 de @webtecnica (issue #2907).
