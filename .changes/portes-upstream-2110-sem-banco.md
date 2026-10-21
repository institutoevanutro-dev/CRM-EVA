---
impacto: capacidade_nova
secao: corrigido
titulo: Campanhas no mesmo número dividem o dia, foto do contato pelo número da conversa, custo de IA pelo cache real e outros consertos do original
---

Portado do projeto original (DeskcommCRM), sem mudança de banco:

- com duas campanhas no mesmo número, a mais antiga que bate o limite do dia
  (ou espera o intervalo ou a janela dela) deixa de travar a seguinte, que
  passa a enviar no ritmo dela (PR #3107 de @RenanzitoIA);
- ao passar a conversa para a equipe, a IA pode registrar que é uma etapa que
  precisa de uma pessoa (por exemplo, concluir um agendamento já coletado),
  sem afirmar que o paciente pediu um atendente. Sem essa informação, segue
  como pedido de atendente; as condições para passar não mudam (PR #3068 de
  @vitor-licassali);
- no cadastro por convite, quando o e-mail de confirmação não pode sair por
  falta de e-mail configurado no login, a tela deixa de mandar "tente
  novamente" e pede para avisar quem convidou (PR #3060 de @rafaelcesardev);
- "Sugerir resposta" deixa de culpar a configuração quando o agente termina
  sem propor resposta: explica que pode ter sido uma decisão e sugere gerar de
  novo (PR #3092 de @paulolimajr77);
- o custo de IA cobra a gravação de cache pelo tempo que a Anthropic informa
  (5 minutos ou 1 hora) em vez de tudo a 1 hora. O gasto mostrado em Uso de IA
  pode ficar menor daqui em diante; o histórico não é recalculado (PR #3119 de
  @jmpo);
- a foto do contato é pedida ao número de WhatsApp da conversa dele, não ao
  primeiro número ativo da clínica; contato sem conversa usa o número mais
  antigo (PR #3110 de @paulolimajr77);
- conversa marcada como exemplo para a IA enquanto aberta e resolvida mais de
  um dia depois passa a entrar no lote que ensina o agente (PR #3071 de
  @Tong-bit-art);
- o detalhe do caso ganha o link "Ver conversa", que abre a conversa na caixa
  de entrada (PR #3082 de @valterhjr).
