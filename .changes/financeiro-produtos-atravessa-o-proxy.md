---
impacto: nada_mudou
secao: corrigido
titulo: A rota de Produtos para o financeiro passa a responder ao token
---

A rota `GET /api/v1/integrations/financeiro/products`, que saiu na 3.1.0, era
barrada com 401 antes de ler o token, porque faltava na lista de caminhos que
dispensam sessão de navegador. O financeiro nunca chegava a receber a lista.
