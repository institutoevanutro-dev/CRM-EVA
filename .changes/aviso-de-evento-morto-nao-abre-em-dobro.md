---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de evento morto não abre mais em dobro na Central
---

Dois processos podiam abrir o mesmo aviso ao mesmo tempo. Agora o banco
recusa o segundo, e reabrir um aviso quando já há um igual aberto responde
com clareza em vez de erro interno. Portado do DeskcommCRM (issue 880,
PR 1928).
