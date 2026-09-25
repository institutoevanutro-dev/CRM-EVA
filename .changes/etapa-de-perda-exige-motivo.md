---
impacto: nada_mudou
secao: corrigido
titulo: Mover um card para uma etapa de perda sem motivo deixa de dar erro 500
---

Mover um card para uma etapa que fecha o negócio como perdido sem informar o
motivo respondia "Erro inesperado", e o card não se movia. Acontecia no arrasto,
no movimento em lote e no movimento feito pelo assistente.

O motivo da perda sempre foi exigência do banco; errada estava a tela, que
devolvia a recusa como falha de servidor.

Agora o arrasto devolve o card e pede o motivo pelo menu "Marcar como perdido"; o
lote avisa antes de tentar, sem derrubar os outros cards; e o assistente não move
o card, avisa na Central que a decisão é de quem está no negócio.

Nada a fazer na instalação.
