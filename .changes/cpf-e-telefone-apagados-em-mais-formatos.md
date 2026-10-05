---
impacto: nada_mudou
secao: corrigido
titulo: CPF e telefone somem das mensagens de erro em mais jeitos de escrever
---

As mensagens de erro que o sistema guarda (inclusive o erro da IA que aparece em IA › Execuções)
passam por um filtro que troca CPF e telefone por `[CPF]` e `[PHONE]`. Esse filtro deixava
passar inteiro:

- telefone sem DDD (`98765-4321`);
- CPF com espaços ou só com pontos (`123 456 789 09`, `123.456.789.09`);
- CPF ou telefone grudado numa palavra (`cpf12345678909`, `zap11987654321`);
- o final de um e-mail que começa por número.

Agora todos esses saem apagados. Os códigos internos que servem para investigar um erro
(identificadores e códigos longos) continuam aparecendo inteiros. As mensagens que já
estavam gravadas não são reescritas.
