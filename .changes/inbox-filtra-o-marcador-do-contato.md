---
impacto: nada_mudou
secao: corrigido
titulo: O filtro por marcador do Inbox procura nas duas caixas onde você marca
---

O Inbox tem duas caixas de marcadores no mesmo painel: a do contato — a mesma
da ficha e a mesma que a campanha lê — e a da conversa, onde o atendimento
automático também encosta os próprios marcadores. O filtro da lista de
conversas procurava só na caixa da conversa.

O efeito era marcar um cliente, filtrar por esse marcador e receber "nenhuma
conversa". Sem erro, sem aviso — a leitura natural é que o CRM perdeu o
marcador. E a lista de opções do filtro sofria do mesmo desencontro: oferecia
só os marcadores da conversa, então o que você acabara de escrever no contato
nem aparecia para ser escolhido.

Agora o filtro encontra a conversa quando o marcador está em qualquer uma das
duas caixas, e a lista de opções junta os marcadores das duas, sem repetir.
Quem já filtrava por marcador de conversa continua achando o mesmo. Sem
marcador filtrado, a lista é a mesma de antes.

Nada muda para quem opera: nenhuma variável nova, nenhum passo na atualização.
A atualização aplica sozinha a função nova do banco que o filtro usa.
