---
impacto: nada_mudou
secao: corrigido
titulo: A IA para de responder quando do outro lado é um robô
---

Quando o número do contato era um atendimento automático (um chatbot que devolve
sempre o mesmo texto pronto), a IA respondia a cada mensagem dele, e os dois ficavam
conversando entre si: em produção foram 37 mensagens da IA em 7 minutos. Isso gasta
modelo e é risco de bloqueio do número no WhatsApp.

Agora, antes de chamar o modelo, o atendimento confere a conversa. Se o contato mandou
a mesma mensagem longa (20 caracteres ou mais) 3 vezes em 10 minutos, ou se a IA mandou
mais de 20 mensagens em 5 minutos sem ninguém da equipe falar, a IA para de responder
sem avisar o contato, a conversa vai para a fila humana e abre UM aviso na Central:
"Possível robô do outro lado". Se for uma pessoa, devolva a conversa à IA pela tela.

Quem repete "oi" ou reenvia a mesma pergunta duas vezes não é afetado. Os limites são
ajustáveis por `BOT_LOOP_REPEAT_COUNT`, `BOT_LOOP_REPEAT_WINDOW_MS`,
`BOT_LOOP_AI_BURST_MAX` e `BOT_LOOP_AI_BURST_WINDOW_MS`; sem nada no `.env`, valem os
números acima.
