---
impacto: capacidade_nova
secao: adicionado
titulo: Assinatura de quem fala na mensagem, menção de colega na nota interna, cópia dos horários da semana e custo da mídia medido
---

Portado do projeto original (DeskcommCRM), sem mudança de banco:

- a mensagem ao cliente pode levar, em negrito na linha de cima, o nome de
  quem fala: o atendente (com as iniciais em maiúscula) ou a IA (nome
  configurável, padrão "Assistente Virtual"). Liga em Configurações ›
  Distribuição de atendimento, separado para atendentes e para a IA, e nasce
  **desligado**. O histórico do CRM guarda o texto como foi escrito; automação,
  sequência de acompanhamento do CRM, integração por token e lembrete da
  agenda não assinam (PR #2079 de @webtecnica);
- na nota interna, digitar `@` abre a lista de atendentes e quem é escolhido é
  o único avisado. O aviso no celular só sai se a pessoa pode ver a conversa
  (PR #2461 de @webtecnica, com os consertos #2489 e #2586 de @Tong-bit-art e
  #2592 de @melgarafael);
- no horário do atendente (Equipe), um botão copia as faixas do primeiro dia
  para segunda a sexta, e depois de salvar o diálogo mostra o que ficou
  gravado (PR #2460 de @webtecnica);
- a leitura de imagem e a transcrição de áudio passam a aparecer em Uso de IA.
  A imagem tem custo pela tabela de preços e passa a somar no gasto do
  mês: quem usa "parar a IA no limite" pode ver a parada chegar um pouco
  antes, e com o limite estourado a imagem também não é enviada ao provedor.
  A transcrição pelo serviço aparece com custo desconhecido. Cada atendimento
  grava o tempo de espera na fila e a duração (PR #2129 e #2617 de
  @melgarafael).
