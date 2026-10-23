---
impacto: capacidade_nova
secao: adicionado
titulo: Cadastro de contato aceita o telefone como o brasileiro escreve e grava o +55 sozinho
---

O Novo contato e a edição da ficha aceitam `(42) 99873-7374`, `42998737374`, fixo como `(42) 3333-4444` e o número colado com `55` sem o `+`, e gravam em formato internacional, como antes. DDD inválido e tamanho errado continuam recusados, com os dois exemplos na mensagem; número com `+` mantém o país digitado. Vale também para a API de contatos. O rótulo do campo vira "Telefone (DDD + número)". Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3305 de @webtecnica).
