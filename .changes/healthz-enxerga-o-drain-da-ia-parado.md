---
impacto: capacidade_nova
secao: corrigido
titulo: Worker de IA parado deixa de responder "saudável" em silêncio
---

O processamento que transforma as mensagens recebidas em respostas da IA roda num laço dentro do serviço do worker. Se esse laço travasse no meio de uma volta, as mensagens continuavam chegando, nenhuma resposta era enfileirada e o healthz do serviço continuava respondendo "ok". Agora o worker carimba cada volta concluída, o healthz responde não saudável quando esse carimbo passa de cinco minutos, e a Central da equipe abre o aviso "As respostas automáticas da IA estão paradas" (o aviso é gravado no mesmo banco, então depende de ele ainda atender). O aviso se resolve sozinho quando o processamento volta.

Ficar sem mensagens não conta como parado: com a clínica em silêncio, com o canal pausado ou antes da estreia, o laço continua dando voltas vazias e carimbando.

Você não precisa fazer nada. Quem acompanha o `docker compose ps` pode ver o worker como `unhealthy` enquanto o laço estiver parado; isso não reinicia o worker nem reverte uma atualização. O `/healthz` do worker ganhou o campo `ia_drain`.
