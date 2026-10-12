Em andamento: o corpo será atualizado com os resultados das suítes completas e a prova pela tela.

## O defeito

O primeiro paciente que pedisse os próprios dados (LGPD) e não tivesse e-mail cadastrado, ou numa instalação sem envio de e-mail, teria o relatório gerado e o pedido preso em "Processando" para sempre: o banco recusava o estado "Revisão pendente" que o sistema tentava gravar, e ninguém lia o erro.

## O conserto

- Migration 0356: o banco passa a aceitar `pending_review` (porte de melgarafael/DeskcommCRM#2788, de @melgarafael).
- Toda gravação de estado do pedido no worker de exportação é conferida.
- O PDF aparece para baixar em "Revisão pendente".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
