---
impacto: nada_mudou
secao: corrigido
titulo: A IA não responde a cada "ok" com a mesma frase
---

Quando o cliente mandava só uma confirmação ("ok", "no aguardo", "por
gentileza"), às vezes várias seguidas, a IA respondia cada uma com quase a mesma
mensagem, e o cliente desconfiava que falava com um robô. Agora, no turno de
resposta, uma mensagem da IA quase igual a uma que ela mandou na mesma conversa
nos últimos 30 minutos não sai. No lugar dela sai uma frase curta fixa ("Ficou
alguma dúvida sobre isso?"), no máximo uma vez por conversa nesse intervalo; se
a IA tentar repetir de novo, a conversa vai para a equipe com um caso aberto.
A frase passa pelas mesmas proteções de qualquer envio (opt-out, anti-ban,
janela). Mensagens curtas, como "Perfeito!", continuam saindo. Follow-ups,
templates, mídias e o aviso de passagem para a equipe não mudam. Os limites e a
frase têm padrão e podem ser ajustados no `.env` (`AI_REPEAT_GUARD_*`; a frase
em `AI_REPEAT_GUARD_FALLBACK`, com variantes separadas por `|`, ou `off` para
só calar), sem precisar mexer em nada para atualizar.
