---
impacto: capacidade_nova
secao: adicionado
titulo: Chave de integração só para o Financeiro
---

Em Configurações › Chaves de integração há uma opção nova, `financeiro:contatos`. Uma chave
criada só com ela deixa o Financeiro ler o nome, o telefone e o e-mail de um contato, e mais
nada: ela não lê conversas, não lista contatos e não usa as ferramentas dos agentes de IA.

Quem já tem uma chave do Financeiro com `mcp:read` não precisa fazer nada: ela continua
funcionando. Para trocar pela chave nova, crie uma chave só com `financeiro:contatos`, coloque-a
no Financeiro e depois revogue a antiga.
