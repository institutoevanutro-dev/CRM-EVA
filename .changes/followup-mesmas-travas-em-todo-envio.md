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
  sequência;
- número em modo de teste (ou contato sem autorização) encerra a sequência com
  o motivo escrito, em vez de deixá-la parada até expirar.

O que continua só no envio feito pelo processo de segundo plano (worker), e
não no atalho do texto fixo: o teto diário e o aquecimento do número, a trava
de texto repetido em massa, a base legal da LGPD e a trava de promessas. Numa
instalação com o worker ligado, ele pega quase todos os passos em segundos.

O follow-up não fala mais por cima de quem está atendendo. A sequência é
encerrada, com o motivo "uma pessoa da equipe está atendendo esta conversa",
quando alguém da equipe respondeu ao contato depois da última mensagem dele
(pela caixa de entrada ou pelo celular), quando a conversa está atribuída a uma
pessoa ou quando o atendimento humano foi pedido. Nos fluxos marcados como
"Permitir durante handoff", atribuição e resposta da equipe não encerram. Em
fluxos disparados por etapa ou por inscrição manual, a mensagem da equipe só
conta quando responde a algo da sequência: o contato falou depois que ela
começou, ou o follow-up já tinha mandado um passo. Mover o negócio para
"Proposta enviada" e depois mandar a proposta não encerra a cobrança. A
saudação e a mensagem de ausência automáticas do WhatsApp Business (até 10
segundos depois da mensagem do contato) não contam como resposta da equipe.
O gatilho de silêncio não reinscreve, no mesmo silêncio, quem foi encerrado
porque uma pessoa da equipe está atendendo.

`{{nome}}` e `{{primeiro_nome}}` saem preenchidos nos passos de texto e de
modelo. Quando o contato não tem nome cadastrado, vale o nome do perfil do
WhatsApp. Sem nenhum dos dois, a variável sai do texto: "Ei, {{primeiro_nome}},
tá por aí?" vira "Ei, tá por aí?". Se o texto era só a variável, o passo é
pulado com o motivo escrito no histórico. Na caixa de entrada, os modelos
também passam a usar o nome do perfil.

Num menu de follow-up, um áudio ou uma imagem em resposta conta como resposta,
como antes, e a espera não recomeça a contar quando nada chega.

O "modelo de reserva" de uma mensagem escrita pela IA agora funciona. Ele sai,
com as mesmas regras, quando a IA tentou enviar e foi barrada pelas regras do
atendimento, ou quando falhou na última tentativa. Ele não sai quando a IA
decidiu não escrever, nem com o agente pausado ou em modo assistido. O
histórico do acompanhamento mostra quando a mensagem saiu pelo modelo de
reserva. Nenhuma ação é necessária.
