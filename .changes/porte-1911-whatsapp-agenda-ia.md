---
impacto: capacidade_nova
secao: adicionado
titulo: WhatsApp preso em "Conectando…" é religado, agenda do Google não trava em evento sem duração, e a IA tem teto de respostas por conversa
---

Três correções trazidas do projeto original:

- A conexão de WhatsApp que fica presa em "Conectando…" passa a ser religada sozinha (até 3 tentativas, sem pedir o QR de novo), e a Central avisa quando ela não volta. Ajustável por `WHATSAPP_STARTING_PRAZO_MS`, `WHATSAPP_STARTING_INTERVALO_MS` e `WHATSAPP_STARTING_LIMITE`; sem eles valem 5 min, 5 min e 3.
- Um evento de duração zero no Google Agenda (início igual ao fim) deixa de travar a sincronização para sempre: ele é ignorado. Quando um evento for recusado, a tela diz o dia e a hora dele.
- A IA para de responder uma conversa que recebeu 50 respostas dela em uma hora e abre um aviso na Central, para a equipe conferir se do outro lado é um robô ou um paciente. Ajustável por `BOT_LOOP_REPLY_CAP` e `BOT_LOOP_REPLY_CAP_WINDOW_MS`.

Nenhuma ação é necessária: sem as variáveis novas no `.env`, valem os padrões.
