---
impacto: nada_mudou
secao: corrigido
titulo: A IA não responde a cada "ok" com a mesma frase
---

Quando o cliente mandava só uma confirmação ("ok", "no aguardo", "por
gentileza"), às vezes várias seguidas, a IA respondia cada uma com quase a mesma
mensagem, e o cliente desconfiava que falava com um robô. Agora, no turno de
resposta, uma mensagem da IA quase igual a uma que ela mandou na mesma conversa
nos últimos 30 minutos não sai, e o turno termina em silêncio, sem erro.
Mensagens curtas, como "Perfeito!", continuam saindo. Follow-ups, templates,
mídias e o aviso de passagem para a equipe não mudam. Os limites têm padrão e
podem ser ajustados no `.env` (`AI_REPEAT_GUARD_*`), sem precisar mexer em nada
para atualizar.
