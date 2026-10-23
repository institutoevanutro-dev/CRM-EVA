---
impacto: nada_mudou
secao: corrigido
titulo: O PARAR que vem depois de uma assinatura em negrito passa a bloquear o contato
---
Quando quem escreve para a clínica é outra empresa com vários atendentes no WhatsApp Business, a mensagem costuma chegar com a assinatura em negrito na primeira linha (por exemplo, `*Amanda:*`) e o texto na segunda. Se o texto era `PARAR`, o pedido não era reconhecido: o contato não era bloqueado e a IA continuava respondendo. Agora a primeira linha em negrito terminada em dois pontos é tratada como assinatura e o resto da mensagem é conferido pela mesma regra de sempre; a mensagem inteira também continua sendo conferida. As frases de paciente que não são pedido de parar (como "tem como parar a dor?") continuam sem bloquear ninguém, com ou sem assinatura. Limite conhecido: um rótulo em negrito com dois pontos seguido de uma palavra de saída (`*Remédio:*` e depois `parar?`) é lido como assinatura e bloqueia, porque não dá para distinguir de um nome. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3158 de @webtecnica).
