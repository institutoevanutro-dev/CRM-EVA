---
impacto: nada_mudou
secao: corrigido
titulo: Proteção das filas internas e da assinatura de formulários
---
As filas de processamento e exclusão de arquivos deixam de aceitar escrita direta por usuários autenticados. Formulários com segredo configurado recusam temporariamente o envio se a chave não puder ser decifrada; a recusa aparece no histórico de captação. Restaure a chave de criptografia da instalação e reenvie os eventos recusados nesse caso.
