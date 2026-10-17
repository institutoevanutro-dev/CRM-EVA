---
impacto: capacidade_nova
secao: corrigido
titulo: Acompanhamento com limite de passos justo, datas certas perto da meia-noite, erros legíveis e outras correções portadas do original
---

Portado do projeto original (DeskcommCRM):

- o limite de 30 passos de um fluxo de acompanhamento conta só o que o
  paciente sente: mensagem, espera e as caixas que esperam a resposta.
  Gatilho, condição, repetir e fim deixam de contar, então uma cadência com uma
  condição em cada toque passa a publicar. Para não publicar um fluxo que o
  motor abandonaria no meio, a publicação também recusa, explicando o motivo,
  o caminho que passa do limite do motor (80 passos). Fluxos já publicados não
  mudam (PR #2965 de @webtecnica);
- das 21h à meia-noite, o filtro "Apenas atrasados" do funil não marca mais
  como atrasado o negócio que fecha hoje, e a linha do tempo do contato mostra
  sob "Hoje" o que aconteceu hoje, e não sob "Ontem" (PRs #2943 e #2944 de
  @webtecnica);
- a aba Atividade das regras automáticas mostra o motivo da falha de uma ação
  (mensagem e código do erro) em vez de "[object Object]" ou só "erro" (PR
  #2986 de @webtecnica);
- a lista de conversas do Inbox não pisca no carregamento quando a Fila troca
  de filtro sozinha, e um recarregamento que falha mantém a lista na tela em
  vez de trocá-la por "Erro ao carregar conversas." (PR #2414 de @webtecnica);
- com a visibilidade "Só os seus", o Atendente que tenta salvar um negócio que
  ficaria fora do que ele vê recebe "sem permissão" com o motivo, e não mais
  "Erro interno. Tente de novo". A regra de visibilidade não mudou (PR #2556 de
  @webtecnica);
- em Admin › Google, a chave secreta colada junto com o resto do arquivo de
  credenciais é recusada na hora, com a instrução do que copiar, em vez de
  falhar só depois, ao conectar a agenda (PR #2493 de @Aleshan-dev);
- os feriados que o prazo de LGPD pula são calculados para qualquer ano, e não
  mais uma lista que terminava em 2030. As datas até 2030 não mudam (PRs #2410
  e #2420 de @Tong-bit-art).

Nada a fazer na VPS: nenhuma migration, nenhuma variável nova.
