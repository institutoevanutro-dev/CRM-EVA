---
impacto: nada_mudou
secao: corrigido
titulo: A sequência de retomada por silêncio não recomeça sozinha
---

O gatilho "contato em silêncio" manda uma sequência de mensagens para quem parou
de responder. Antes, quando a sequência terminava sem resposta (ou era encerrada
porque uma pessoa da equipe assumiu, a etapa do funil bloqueia ou o contato foi
anonimizado), o contato continuava calado e, um minuto depois, a mesma sequência
começava de novo, do primeiro toque, sem fim.

Agora:

- **Uma sequência por silêncio.** Depois que ela termina, o contato só recebe
  outra se responder e ficar calado de novo pelo tempo configurado.
- **Contato antigo não recebe nada ao ligar o fluxo.** Só conta quem mandou
  mensagem depois que o fluxo foi ativado. Antes, ativar um fluxo de silêncio
  mandava a sequência de uma vez para toda conversa aberta calada, inclusive de
  meses atrás. Isso vale também na atualização: quem já estava calado na hora de
  atualizar não recebe a sequência daquele silêncio.
- **Contato anonimizado fica de fora.**
- **Mais de mil conversas abertas** passam a ser todas consideradas, e não só um
  pedaço escolhido pelo banco.

Para que **qualquer resposta encerre a sequência**, ligue "cancelar ao responder"
no gatilho do fluxo. Essa opção vem desligada: sem ela, a resposta do contato
segue para o próximo passo do fluxo.

Uma dica de implantação: se você armar o fluxo num agente depois de ativá-lo,
desative o fluxo e publique de novo. Assim, quem ficou calado entre ativar o
fluxo e armar o agente não recebe a sequência de uma vez. Publicar uma versão
nova de um fluxo que já está ativo, mudar o tempo de silêncio ou o "cancelar ao
responder" não mexem nisso.

Nenhuma ação é necessária.
