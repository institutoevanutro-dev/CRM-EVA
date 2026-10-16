---
impacto: capacidade_nova
secao: adicionado
titulo: Quem escreve fora do horário de atendimento pode receber um aviso automático — uma vez por contato por período fechado (desligado por padrão)
---
Quem escrevia fora do horário de funcionamento do agente não recebia nada até a abertura: no sábado à noite, silêncio até segunda de manhã, e a pessoa sem saber se a mensagem chegou. Agora a tela de gatilho do agente (em "Só atender em horário de funcionamento") aceita um texto de aviso, e esse texto é enviado quando a mensagem chega fora do horário. Vale só para quem preencher o texto: o padrão é não enviar nada, e quem não mexer na tela não vê mudança nenhuma.

O aviso sai no máximo uma vez por contato por período fechado (o período começa quando o horário fecha e só volta a valer quando ele abre e fecha de novo). Não recebem nunca: contato bloqueado ou que pediu para parar (inclusive quando a própria mensagem é um pedido para parar), contato com atendimento só humano, contato oculto do Inbox, titular anonimizado, conversa de grupo e número da própria clínica. O aviso respeita a janela de envio do número, o aquecimento, o teto diário e o espaçamento, e conta como uma mensagem enviada. Quando o horário abre, a IA responde normalmente.

Porte de melgarafael/DeskcommCRM#2284.
