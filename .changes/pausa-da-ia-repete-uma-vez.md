---
impacto: nada_mudou
secao: corrigido
titulo: A pausa da IA no atendimento manual tenta de novo uma vez quando a gravação não pega
---

Quando alguém da equipe responde pelo próprio WhatsApp, fora do CRM, a IA fica pausada naquela conversa. Se a gravação dessa pausa não pegasse (por uma disputa momentânea no banco), o CRM desistia na primeira tentativa e a IA podia responder por cima de quem atende. Agora ele confere se a conversa ainda existe e, se existir, tenta gravar a pausa mais uma vez. Se nem assim der certo, o registro de erro do servidor diz o motivo. Não há nada a fazer.

Portado do projeto original (DeskcommCRM, PR #4296 de @webtecnica).
