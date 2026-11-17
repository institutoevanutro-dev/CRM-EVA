---
impacto: capacidade_nova
secao: adicionado
titulo: Vendido por origem no funil do Marketing
---

Com o Financeiro ligado, a integração do Marketing (`/api/v1/integrations/marketing/funil-por-origem`)
passa a devolver, em cada origem, `vendido_cents` (o vendido no período, parcelado inclusive) e
`compradores` (contatos com venda no período), lidos do Financeiro pelos contatos do funil. O painel
de anúncios usa isso para mostrar CAC e ROAS por canal. Sem o Financeiro, os campos não vêm.
