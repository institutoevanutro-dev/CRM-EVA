---
impacto: nada_mudou
secao: corrigido
titulo: O pedido de horário que ninguém confirmou agora expira de verdade e libera o horário
---
Quando um tipo de atendimento exige confirmação, o pedido fica "aguardando confirmação" e segura o horário. Se ninguém decidir dentro do prazo (24 horas por padrão, ajustável por organização), o sistema deveria cancelar o pedido e devolver o horário à agenda. Isso nunca funcionou: a rotina que roda a cada 15 minutos tentava cancelar de um jeito que o próprio banco recusava, e o pedido abandonado ficava segurando o horário para sempre.

Agora o cancelamento passa pelo mesmo caminho de um cancelamento feito por uma pessoa da equipe: o horário é liberado, o compromisso some do Google Agenda, o follow-up preso àquele compromisso é encerrado e a linha "Agendamento cancelado" aparece no histórico do negócio, com o motivo "Pedido expirado: ninguém confirmou dentro do prazo."

O prazo passou a contar do momento em que o compromisso ficou "aguardando confirmação", e não do momento em que foi criado. Com a regra antiga, uma consulta antiga que voltasse a "aguardando confirmação" já seria considerada vencida na mesma hora.

Travas novas: só são expirados pedidos de horários que ainda vão acontecer (o que já passou e a agenda importada não são tocados); no máximo 20 pedidos por rodada, e o resto espera a rodada seguinte com um alerta no log; se alguém confirmar ou remarcar no meio do caminho, o pedido fica como a pessoa deixou.

O sistema não manda WhatsApp ao cliente quando o pedido expira, e as automações de "quando um horário for cancelado" não disparam nesse caso. Uma exceção fora do CRM: se o pedido já estava no Google Agenda com o e-mail do cliente como convidado, o Google envia o aviso de cancelamento dele.

Nada precisa ser feito ao atualizar. Não há mudança de banco.
