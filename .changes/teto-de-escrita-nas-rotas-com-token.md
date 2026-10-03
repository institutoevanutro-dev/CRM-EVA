---
impacto: nada_mudou
secao: corrigido
titulo: Teto de escrita por token nas rotas que aceitam token de servidor
---

As rotas que aceitam token de servidor (Bearer `dsk_`) não tinham teto nenhum: envio de mensagem (`messages`), upload de mídia da conversa e abertura de conversa pelo contato compartilhado. Uma integração em laço podia mandar mensagens sem limite pelo número da operação. Agora cada uma dessas rotas aceita até 30 chamadas por minuto por token e 600 por minuto por organização, e responde 429 com `Retry-After` quando passa disso. O anexo de nota interna recebe o mesmo teto como defesa em profundidade. Quem usa pela tela do navegador não tem teto e não percebe diferença. Não é preciso fazer nada na instalação.

Portado do projeto original (DeskcommCRM PR 2012 de @webtecnica).
