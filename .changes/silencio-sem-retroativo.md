---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up de silêncio não manda mais mensagem para conversa antiga
---

Publicar um fluxo de silêncio, ativá-lo ou abrir o acesso da IA ao canal não inscreve mais conversas que já
estavam paradas antes disso: só conta o silêncio que começou depois de o fluxo valer para aquela conversa.
Como segunda trava, ninguém calado há mais que o limiar do fluxo + 24 horas é inscrito (ajustável em
`FOLLOWUP_SILENCIO_ATRASO_MAXIMO_HORAS`, sem precisar editar o `.env`). Quem já roda não precisa fazer nada.
