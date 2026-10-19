---
impacto: capacidade_nova
secao: adicionado
titulo: A etapa do funil pode avisar a equipe na Central e as Métricas ganham o relatório por número
---

Portado do projeto original (DeskcommCRM), com duas mudanças de banco
(migrations 0387 e 0388):

- em Configurações › Funis › Etapas, cada etapa ganhou a chave "Avisar a
  equipe na Central quando um negócio entrar aqui". Ligada, todo negócio que
  entra nela (arrasto no quadro, automação ou assistente de IA) abre um aviso
  na Central com o botão "Abrir negócio". O aviso diz só a etapa, nunca o nome
  ou o telefone do paciente, e não se repete enquanto o anterior do mesmo
  negócio estiver aberto. Vem desligada em todas as etapas (PR #1813 de @jmpo);
- em Métricas, quem é gerente vê o quadro "Por canal": por número ou conexão,
  quantas conversas foram atribuídas no período, o tempo médio até a primeira
  resposta de uma pessoa (a IA fica de fora) e quantas ficaram sem resposta.
  São só totais, sem dado de paciente. A janela vai até 90 dias (PR #2504 de
  @webtecnica, com o conserto de desempenho do #2554 de @Tong-bit-art).

A atualização reaplica o baseline: cria a coluna da etapa, a função do
relatório e um índice novo em mensagens.
