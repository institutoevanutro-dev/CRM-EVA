---
impacto: nada_mudou
secao: corrigido
titulo: O rodízio não entrega ao atendente conversa cujo caso já não pede uma pessoa
---

Uma conversa com caso aberto pela IA continuava na fila do rodízio mesmo quando o caso já não pedia ninguém: a bola estava com o paciente (caso "aguardando o cliente") ou o caso já tinha sido concluído ou cancelado sem que a conversa fosse fechada. Horas depois, o rodízio entregava essa conversa a um atendente que não tinha nada a fazer nela. Agora o rodízio confere o caso mais recente da conversa antes de distribuir: casos que pedem a equipe ("aguardando atendimento" ou "escalado") continuam sendo distribuídos como antes, e se o paciente escrever de novo depois do pedido ou da conclusão do caso, a conversa volta à fila normalmente. Conversas sem caso não mudam. Não há nada a fazer.

Portado do projeto original (DeskcommCRM, PR #3739 de @webtecnica).
