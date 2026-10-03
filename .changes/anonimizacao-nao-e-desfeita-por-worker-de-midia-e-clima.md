---
impacto: nada_mudou
secao: corrigido
titulo: A anonimização de um contato não é mais desfeita por um worker de mídia ou de clima que estava no meio do trabalho
---

O worker que guarda a mídia recebida e o que mede o clima da conversa passam a
aplicar, na própria gravação, a mesma guarda do worker de transcrição: mensagem
já anonimizada não recebe dado de volta. Se a mídia terminar de subir depois da
anonimização, o arquivo é removido do armazenamento e a transcrição não é pedida.
Portado do DeskcommCRM PR 2191 (@melgarafael).
