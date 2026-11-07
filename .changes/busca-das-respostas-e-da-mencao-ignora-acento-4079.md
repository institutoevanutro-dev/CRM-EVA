---
impacto: nada_mudou
secao: corrigido
titulo: A busca das respostas rápidas e da menção acha o nome mesmo quando o acento está só de um lado
---

No campo de mensagem da Inbox, a busca das respostas rápidas (pelo `/` e na barra de respostas) e a menção da nota interna tratavam acento como outra letra: `/orcamento` não achava a resposta "Orçamento", e `@andreia` não achava a colega "Andréia". Agora as duas comparam sem acento e sem caixa, nos dois sentidos: quem digita com acento também acha o nome cadastrado sem. O texto exibido não muda, e na nota continua gravado o nome como está cadastrado. A busca da barra de respostas passa a achar também pelo atalho, como o menu do `/` já fazia.

Portado do projeto original (DeskcommCRM, PR #4079 de @webtecnica).
