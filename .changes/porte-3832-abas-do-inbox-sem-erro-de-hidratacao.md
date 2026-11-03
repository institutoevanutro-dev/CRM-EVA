---
impacto: nada_mudou
secao: corrigido
titulo: As abas do Inbox carregam sem erro de hidratação
---

O número ao lado das abas do Inbox e o seletor de número da empresa passam a aparecer logo
depois que a página termina de carregar. Se esses dados chegassem no meio do carregamento, o
navegador registraria um erro de hidratação e montaria a área de novo. A correção é
preventiva: o caso só é provável para quem administra, que tem o indicador de conexões no
menu. Nada precisa ser feito na instalação.

Portado do projeto original (DeskcommCRM, PR #3832 de @webtecnica), adaptado.
