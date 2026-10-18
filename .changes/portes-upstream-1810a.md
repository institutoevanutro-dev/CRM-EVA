---
impacto: capacidade_nova
secao: adicionado
titulo: Conversa parada com uma pessoa pode voltar à IA sozinha, e o acompanhamento passa a mover o card no funil e pôr ou tirar etiqueta
---

Portado do projeto original (DeskcommCRM):

- em Configurações › Distribuição de atendimento dá para ligar um prazo (de 5
  minutos a 24 horas) para a conversa que ficou com uma pessoa voltar ao
  agente de IA sozinha, quando ninguém da equipe deu mais sinal — nem assumiu,
  nem respondeu pela tela ou pelo celular. O tempo conta do último sinal. A
  volta é a mesma do botão "Devolver": as travas saem, o acompanhamento pausado
  retoma e a linha do tempo diz que foi o prazo. Só devolve onde há agente
  publicado que atenda naquele número (respeitando a lista de números de cada
  agente) e nunca devolve contato marcado como "sempre atendimento humano" nem
  quem pediu para parar. A devolução não manda mensagem: a IA só responde à
  próxima mensagem do cliente, com a janela de envio e o ritmo de sempre.
  **Desligado por padrão**, inclusive em quem já tem o sistema: nada muda até
  alguém ligar (PR #1133 de @Gervanno);
- o acompanhamento ganhou duas caixas que não falam com o cliente: "Mover lead
  no funil" (leva o card para a etapa escolhida do mesmo funil, pelo mesmo
  caminho do quadro) e "Etiqueta do lead" (põe ou tira etiquetas do negócio;
  sem negócio, do contato). Tirar etiqueta é acréscimo nosso. A publicação
  recusa a caixa sem etapa ativa ou sem etiqueta. Fluxos já publicados não
  mudam (PR #2181 de @webtecnica).
