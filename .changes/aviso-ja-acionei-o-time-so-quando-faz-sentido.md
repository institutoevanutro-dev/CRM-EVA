---
impacto: nada_mudou
secao: corrigido
titulo: A frase "já acionei o time" só sai quando faz sentido, e uma vez por dia
---

Quando o atendimento automático passa a conversa para uma pessoa, o paciente
recebe um aviso como "Já acionei o time". Esse aviso saía em casos errados:

- para quem nunca tinha recebido nenhuma mensagem automática naquela conversa
  (o detector de clima da conversa roda em toda mensagem, mesmo sem IA ligada);
- repetido várias vezes seguidas quando o envio travava e era tentado de novo.

Agora o aviso só sai se já houve mensagem automática na conversa, e no máximo
uma vez a cada 24 horas por conversa. Um aviso que falhou e nunca chegou não
conta, e o próximo sai normalmente.

E quem responde começando com "parar" (por exemplo "Parar não é daqui") e cai
nessa passagem recebe a confirmação de que as mensagens automáticas vão parar,
e não a promessa de que um atendente vai responder. Perguntas como "tem como
parar a dor?" ou "parar de tomar o remédio faz mal?", e frases como "pare de
mandar o pedido nesse endereço", não mudam nada.

As frases do aviso também perderam o travessão.

Portado do projeto original (DeskcommCRM, trabalho de jmpo, melgarafael, Paulo
Lima Jr e webtecnica).
