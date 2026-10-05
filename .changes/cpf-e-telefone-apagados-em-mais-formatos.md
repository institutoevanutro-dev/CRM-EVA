---
impacto: nada_mudou
secao: corrigido
titulo: CPF e telefone somem das mensagens de erro em mais jeitos de escrever
---

As mensagens de erro que o sistema guarda (inclusive o erro da IA que aparece em IA › Execuções)
passam por um filtro que troca CPF e telefone por `[CPF]` e `[PHONE]`. Esse filtro deixava
passar inteiro:

- telefone sem DDD (`98765-4321`), agrupado de três em três (`27 999 991 234`) ou de fora do
  Brasil com o `+` na frente (`+351 912 345 678`);
- CPF com espaços, só com pontos, com barra ou com vírgula (`123 456 789 09`, `123.456.789.09`,
  `123.456.789/09`);
- CPF ou telefone grudado numa palavra (`cpf12345678909`, `zap11987654321`);
- o final de um e-mail que começa por número.

Agora todos esses saem apagados. O que serve para investigar um erro continua aparecendo
inteiro: identificadores e códigos longos, endereço de servidor (IP) e números soltos como um
limite de uso. As mensagens que já
estavam gravadas não são reescritas.
