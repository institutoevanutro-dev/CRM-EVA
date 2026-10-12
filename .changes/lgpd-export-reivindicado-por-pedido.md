---
impacto: nada_mudou
secao: corrigido
titulo: Um pedido de dados do titular (LGPD) gera uma exportação só
---
Quando dois avisos internos do mesmo pedido de dados eram processados ao mesmo tempo (por exemplo, a aprovação e uma nova tentativa automática), o sistema podia montar o arquivo e enviar o e-mail ao titular duas vezes, e a trilha de auditoria registrava duas entregas para um pedido só. Agora cada pedido é reservado por quem começou a exportar: o segundo aviso é dispensado sem refazer nada. Se a exportação falhar ou o serviço cair no meio, a reserva é liberada e a próxima tentativa retoma o pedido, então nenhum pedido fica preso.

A atualização acrescenta uma coluna ao banco (`lgpd_requests.export_claimed_at`), aplicada sozinha pelo deploy.

Você não precisa fazer nada.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2752, de @Tong-bit-art).
