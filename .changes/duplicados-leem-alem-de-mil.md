---
impacto: nada_mudou
secao: corrigido
titulo: Duplicados varre além dos primeiros 1.000 contatos
---

A tela Contatos › Duplicados lia só os 1.000 contatos mais antigos e dizia que tinha
varrido todos, porque o banco corta cada resposta em 1.000 linhas sem avisar. Agora a
leitura é feita em páginas, até 2.000 contatos, e a tela avisa quando há mais do que isso.
Nada era gravado errado antes: era a leitura que parava cedo.

Portado do projeto original (DeskcommCRM, PR #2585 de @Tong-bit-art, issue #2561).
Nada a fazer na VPS.
