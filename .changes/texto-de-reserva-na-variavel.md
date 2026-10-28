---
impacto: capacidade_nova
secao: adicionado
titulo: Texto de reserva para variáveis das mensagens
---

Agora dá para escrever `{{primeiro_nome|"aluno"}}` numa mensagem: se o contato não tiver o dado, sai o texto entre aspas ("Oi aluno!") em vez de a variável ficar vazia ou a pessoa ficar de fora. Vale nas respostas rápidas do Inbox, no WhatsApp e no e-mail das automações, no texto fixo do follow-up, nos modelos de mensagem da API de operação e na campanha de texto livre. Aspas retas ou curvas, de 1 a 100 caracteres, sem chaves nem aspas dentro. Com o dado preenchido, a reserva é ignorada; quem não usa `|` não percebe nenhuma mudança. Nada muda na VPS.

Portado do projeto original (DeskcommCRM, PR #3535 de @melgarafael, a partir do #3405 de @xxfabioxx12).
