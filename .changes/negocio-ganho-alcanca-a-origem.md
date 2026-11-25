---
impacto: nada_mudou
secao: corrigido
titulo: Regra «Quando um negócio for ganho» volta a enviar WhatsApp e iniciar fluxo de mensagens
---
Uma regra «Quando um negócio for ganho» com uma ação de WhatsApp (enviar
mensagem, iniciar fluxo de mensagens ou mensagem da IA) terminava pela metade:
o card criado pela regra aparecia, mas a mensagem falhava por dentro e a
execução ficava parcial. A causa era o resolvedor que liga o evento ao contato da
conversa: ele conhecia a criação, a mudança de etapa e a etiqueta do negócio,
mas não o ganho nem a perda.

Agora o ganho e a perda do negócio também resolvem o contato, e a ação de
mensagem sai como qualquer outra. Regras que já funcionavam continuam iguais, e
a reabertura do negócio segue fora. Vale para os negócios ganhos depois da
atualização (migration 0437), aplicada sozinha. Nada a fazer. Porte de
melgarafael/DeskcommCRM#5163 (contribuição de @webtecnica).
