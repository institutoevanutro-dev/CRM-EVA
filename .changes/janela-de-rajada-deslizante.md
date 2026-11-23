---
impacto: nada_mudou
secao: corrigido
titulo: Mensagens seguidas do mesmo contato viram uma resposta só, e a espera para de crescer sem fim
---
Quando o cliente escreve em várias bolhas, o CRM já juntava as mensagens do
mesmo contato numa resposta só, mas a janela dessa junção era fixa: nascia com
a primeira mensagem e não andava. Bolhas com 10 a 20 segundos de intervalo
caíam fora dela, e o agente respondia uma vez para cada bolha. Agora a janela
anda a cada mensagem nova e para num teto contado da primeira: 45 s por padrão,
na variável `INBOUND_BURST_MAX_MS` do worker (`0` volta à janela fixa de antes).
Quem escreveu uma mensagem só recebe a resposta no mesmo tempo de antes. Nada a
fazer na atualização. Porte de melgarafael/DeskcommCRM#4977.
