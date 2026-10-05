---
impacto: nada_mudou
secao: alterado
titulo: Sai a rota de Produtos para o financeiro
---

A rota `GET /api/v1/integrations/financeiro/products`, que entrou na 3.1.0, foi
removida. Desde 04/10/2026 o financeiro recebe os serviços só do PrecificaEva e
deixou de chamá-la; o caminho também saiu da lista dos que dispensam sessão de
navegador. A exportação de contato para o financeiro e os totais para o painel
de marketing seguem como estavam.
