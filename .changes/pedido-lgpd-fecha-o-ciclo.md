---
impacto: nada_mudou
secao: corrigido
titulo: Pedido de dados do titular (LGPD) sem e-mail para entrega passa a "Revisão pendente", com o PDF para você entregar, em vez de ficar em "Processando" para sempre
---
Quando o relatório de dados pessoais ficava pronto e não havia como entregar por e-mail (instalação sem envio de e-mail configurado, ou titular sem endereço cadastrado), o pedido nunca saía de "Processando": o banco recusava o estado "Revisão pendente" e o sistema seguia calado, registrando na trilha que o relatório tinha sido gerado. A tela não oferecia o PDF, e a limpeza automática de mídias antigas da organização ficava parada enquanto houvesse um pedido assim.

Agora o pedido vai para "Revisão pendente", e a página do pedido, em LGPD › Solicitações, mostra o botão "Baixar PDF" para você entregar o relatório ao titular por um canal seu. O mesmo estado passa a valer para os pedidos de anonimização que caem em revisão (contato sem registro local, ou anonimização da organização com falha parcial).

Além disso, o sistema deixa de engolir erro ao gravar o andamento do pedido. Se o banco recusar qualquer mudança de estado, o erro vai para o log, o pedido volta para a fila ou é marcado como "Falhou" com o motivo, e o relatório nunca é reenviado ao titular por causa disso. E aprovar um pedido quando o processamento não consegue ser iniciado responde erro e deixa o pedido como estava, para você aprovar de novo, em vez de deixá-lo em "Processando" sem ninguém processando.

Você não precisa fazer nada: pedidos que já estavam presos em "Processando" por esse motivo são corrigidos na atualização, desde que a trilha de auditoria mostre que o relatório foi gerado.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2788, de @melgarafael), com a conferência de erro estendida às demais gravações.
