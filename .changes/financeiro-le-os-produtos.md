---
impacto: capacidade_nova
secao: adicionado
titulo: O financeiro passa a ler a tabela de Produtos
---

Nova rota só de leitura, `GET /api/v1/integrations/financeiro/products`, para o
Catálogo do financeiro receber nome, categoria e preço dos serviços cadastrados
em Produtos. Usa o mesmo token e a mesma organização da integração que já
existe; quem não usa o financeiro não percebe diferença.
