---
impacto: nada_mudou
secao: corrigido
titulo: Mover um card para uma etapa de perda sem motivo deixa de dar erro 500
---

Mover um card para uma etapa que fecha o negócio como perdido sem informar o
motivo respondia "Erro inesperado" (500) — e o card não se movia, sem dizer por
quê. Acontecia nos três caminhos que trocam a etapa do negócio: o arrasto no
quadro, o movimento em lote e o movimento feito pelo assistente de IA.

O motivo da perda é exigência do banco desde sempre (a etapa de perda fecha o
negócio, e fechar como perdido sem causa registrada não é permitido). Quem estava
errado era a tela, que deixava a pergunta chegar ao banco e devolvia a recusa como
falha de servidor.

Agora a resposta é a recusa de negócio, com o que fazer: no arrasto, o card volta
para a coluna de origem e a tela avisa "Informe o motivo da perda: use “Marcar
como perdido” no menu do card, que pede o motivo."; no lote, a recusa avisa antes de tentar, em vez de derrubar o lote inteiro
por causa de um card; e o assistente de IA não leva o card para a etapa de perda:
ele avisa na Central que o negócio deveria ser marcado como perdido e que o motivo
é uma decisão de quem está no negócio. O aviso não se repete a cada mensagem do
cliente: enquanto o primeiro estiver aberto na Central, não nasce outro igual para o
mesmo negócio.

Nenhuma ação é necessária na instalação: a regra do banco não mudou e nenhum dado
foi tocado.
