---
impacto: nada_mudou
secao: corrigido
titulo: O "Editar" do card não grava mais o Valor por cima da soma das vendas
---
Num negócio com venda registrada, o Valor é a soma das vendas. Antes, salvar pelo "Editar" do card, pelo MCP ou pela API gravava um número digitado por cima dessa soma, e o card passava a mostrar um valor diferente do painel de vendas. Agora o "Editar" mostra a soma só para leitura, e o servidor ignora o valor enviado enquanto o negócio tiver venda registrada. Os outros campos da edição seguem gravando normalmente. Porte de melgarafael/DeskcommCRM#5231.
