---
impacto: capacidade_nova
secao: alterado
titulo: Painel de vendas puxa as vendas do Financeiro quando ele está ligado
---
Com o Financeiro ligado (`FINANCEIRO_URL`, `FINANCEIRO_TOKEN` e
`FINANCEIRO_ORGANIZATION_ID`), Análise › Vendas mostra, para gestor e admin,
Vendas, Valor vendido, Ticket médio, o gráfico e "Clientes que mais compram"
a partir do vendido no Financeiro no período. A conversão continua vindo do
funil. Funil e tag passam a filtrar só a conversão e a lista do CRM, e os
rankings de tags e funis somem nesse modo. Vendas registradas no CRM não
entram nos cartões, para não contar em dobro. Se o Financeiro não responder,
a tela avisa e deixa esses cartões em branco. Precisa do Financeiro com a
rota `vendas-do-periodo` (eva-financeiro, migration 0088). Sem o Financeiro,
nada muda.
