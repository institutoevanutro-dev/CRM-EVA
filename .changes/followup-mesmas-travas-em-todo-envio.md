---
impacto: nada_mudou
secao: corrigido
titulo: O follow-up respeita as mesmas regras por qualquer caminho, não fala por cima da equipe e sai com o nome do contato
---

Um passo de texto fixo do follow-up podia sair por um atalho que não conferia
as regras de envio. Agora ele passa pelas mesmas conferências da mensagem
escrita pela IA:

- respeita a janela de envio configurada para a organização e o horário de
  envio do número (por padrão, das 7h às 22h). Fora dela, o passo espera a
  abertura;
- se o fluxo encerra quando o contato responde, a resposta encerra antes de o
  passo sair, também quando ela chega no meio de uma espera;
- etapa do funil que interrompe follow-ups e contato anonimizado encerram a
  sequência.

O follow-up não fala mais por cima de quem está atendendo. A sequência é
encerrada, com o motivo "uma pessoa da equipe está atendendo esta conversa",
quando alguém da equipe respondeu ao contato depois da última mensagem dele
(pela caixa de entrada ou pelo celular), quando a conversa está atribuída a uma
pessoa ou quando o atendimento humano foi pedido. Nos fluxos marcados como
"Permitir durante handoff", atribuição e resposta da equipe não encerram. Em
fluxos disparados por etapa ou por inscrição manual, só conta a resposta dada
depois que a sequência começou.

`{{nome}}` e `{{primeiro_nome}}` saem preenchidos nos passos de texto e de
modelo. Quando o contato não tem nome cadastrado, vale o nome do perfil do
WhatsApp. Sem nenhum dos dois, a variável sai do texto: "Ei, {{primeiro_nome}},
tá por aí?" vira "Ei, tá por aí?". Na caixa de entrada, os modelos também passam
a usar o nome do perfil.

O "modelo de reserva" de uma mensagem escrita pela IA agora funciona. Ele sai,
com as mesmas regras, quando a IA tentou enviar e foi barrada pelas regras do
atendimento, ou quando falhou na última tentativa. Ele não sai quando a IA
decidiu não escrever, nem com o agente pausado ou em modo assistido. O
histórico do acompanhamento mostra quando a mensagem saiu pelo modelo de
reserva. Nenhuma ação é necessária.
