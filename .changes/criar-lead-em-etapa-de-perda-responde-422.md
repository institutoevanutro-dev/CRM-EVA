---
impacto: nada_mudou
secao: corrigido
titulo: Criar um negócio direto numa etapa de perda sem motivo responde 422, não erro interno
---
Criar um negócio já numa etapa de perda e sem informar o motivo respondia erro interno (500) com o texto cru do banco. Agora a resposta é 422 `lost_reason_required`, com a mesma frase que a ação "marcar como perdido" devolve. Vale para a criação pela API, pela importação de planilha e pelas fontes de captação que apontam para uma etapa de perda. Outros erros do banco continuam como antes.

Você não precisa fazer nada.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2762, de @webtecnica).
