---
impacto: capacidade_nova
secao: adicionado
titulo: Cadastro de contato aceita o telefone como o brasileiro escreve e grava o +55 sozinho
---

Quem cadastrava contato à mão tinha de digitar o número no formato internacional completo, `+5542998737374`, com o `+` e o código do país, ou o campo recusava com "Telefone deve estar em formato E.164". Agora o Novo contato e a edição da ficha aceitam o número como o brasileiro escreve: `(42) 99873-7374`, `42 99873-7374`, `42998737374` e `(42) 3333-4444` para fixo, com ou sem máscara, e também o número colado com o `55` na frente mas sem o `+`. O `+55` entra uma vez só, e o contato é gravado em formato internacional, exatamente como antes: nada muda no banco nem para quem já tinha o número gravado.

O DDD é conferido pela mesma régua que o sistema já usa para reconhecer o mesmo número em duas grafias (dois dígitos, o primeiro de 1 a 9), então DDD inválido e tamanho errado continuam recusados, agora com uma mensagem que mostra os dois exemplos. Número escrito com `+` mantém o código de país digitado: `+1 (415) 555-1234` continua sendo dos Estados Unidos. A regra vale também para a API de contatos (`POST` e `PATCH /api/v1/contacts`), e integração que já manda o formato internacional segue igual. O rótulo do campo passa a dizer "Telefone (DDD + número)". Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3305 de @webtecnica).
