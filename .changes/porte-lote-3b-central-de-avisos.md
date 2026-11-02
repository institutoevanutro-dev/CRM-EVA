---
impacto: capacidade_nova
secao: corrigido
titulo: Menos avisos falsos de promessa na Central, encerrar caso sem avisar o cliente e resposta ao paciente fora do limite do dia
---

Portado do projeto original (DeskcommCRM):

- quando o agente só oferece atendimento humano ("Quer que eu encaminhe para a
  equipe?"), isso deixa de contar como promessa de humano, inclusive com uma
  abertura curta de reconhecimento antes ("Entendi! Quer que eu encaminhe para
  a equipe?"). Antes o envio era vetado e podia virar caso automático e aviso
  de promessa não cumprida na Central. Qualquer frase que prometa algo de fato
  continua sendo conferida (PR #2629 de @vitorlacerdadigital, a parte da
  pergunta de consentimento, e PR #3740 de @webtecnica);
- "Já encaminhei!" ou "Pronto, encaminhado!" sem dizer o quê passa a contar
  como promessa de humano e só sai se alguém tiver sido acionado de fato.
  "Já te encaminhei o link" segue livre (PR #3786 de @melgarafael);
- na tela do caso aparece a opção "Encerrar sem avisar o cliente", para o caso
  que perdeu o sentido. A nota é obrigatória e fica só no caso; o caso vira
  cancelado, os avisos da Central daquele caso (inclusive o lembrete de caso
  parado) somem na hora e nada é enviado ao cliente. A mesma ação existe em
  `POST /api/v1/ai/cases/{id}/close` (PR #3819 de @webtecnica);
- o limite diário do número (aquecimento e Conexões, Proteção de envio) passa a
  contar só as mensagens que o número inicia: primeira mensagem, follow-up e
  campanha. A resposta a quem acabou de escrever não conta e não fica mais para
  o dia seguinte; a janela de resposta e o intervalo entre mensagens continuam
  valendo. Migration 0399, aplicada pela atualização normal (PR #3769 de
  @ZvisionAutomations).

Nada precisa ser feito na instalação.
