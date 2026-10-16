---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem que o contato editou ou apagou para todos passa a aparecer assim na conversa
---

Quando o contato editava ou apagava para todos uma mensagem que tinha mandado, o CRM seguia mostrando o texto antigo, sem aviso nenhum: o evento chegava e era marcado como processado, mas não encontrava a mensagem, porque a recebida é guardada com o identificador completo e o aviso de edição traz só a parte final dele. Agora a edição atualiza o texto e o apagar marca a mensagem como apagada também nas mensagens recebidas; as enviadas pelo atendente seguem como antes. Nada a fazer na atualização.

Contribuição de @webtecnica (#2956), a partir da issue #2939 de @el-barreto.
