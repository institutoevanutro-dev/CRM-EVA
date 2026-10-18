---
impacto: nada_mudou
secao: corrigido
titulo: Link de mídia e foto só do próprio dono, e mensagens só alteradas por quem vê a conversa
---

Correções de segurança da auditoria de 17/10:

- o link da mídia de uma mensagem, da foto de um contato e do PDF de um pedido
  da LGPD só é gerado para o arquivo daquela mensagem, daquele contato ou
  daquele pedido, na organização de quem pede. Um endereço de arquivo de outra
  conversa ou de outra organização gravado na linha passa a responder
  "não encontrado";
- o banco recusa, na escrita feita com a sessão de um usuário, endereço de
  mídia fora da conversa da própria mensagem e qualquer foto de contato (quem
  grava a foto é o servidor);
- uma pessoa da equipe só altera mensagem de conversa que ela consegue ver, e
  só apaga o eco do próprio envio, que é o que o sistema já fazia.

Nada a fazer na VPS: a migration 0382 entra pelo baseline na atualização
normal. Nenhuma variável nova.
