---
impacto: nada_mudou
secao: corrigido
titulo: A devolução automática ao agente não toma mais a conversa que alguém da equipe acabou de assumir ou responder
---
Com a devolução automática ligada, a rotina lê as conversas e, logo depois,
devolve ao agente de IA as que passaram do prazo sem resposta da equipe, ou
aquelas em que o cliente escreveu durante a pausa e ninguém respondeu. Se nesse
intervalo alguém da equipe assumisse a conversa ou respondesse o cliente, a
rotina não via a mudança e devolvia a conversa à IA mesmo assim, logo depois de
a pessoa entrar nela.

Agora a devolução confere, na hora de gravar, que a conversa continua com o
mesmo responsável e que ninguém da equipe assumiu ou respondeu depois da
leitura. Se mudou, a conversa fica com a pessoa e a rodada segue para a
próxima, sem contar como falha. O banco ganha uma função de apoio (migration
0436), aplicada pela atualização normal. Nada a fazer. Porte de
melgarafael/DeskcommCRM#5183.
