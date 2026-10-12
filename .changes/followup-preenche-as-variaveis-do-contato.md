---
impacto: capacidade_nova
secao: corrigido
titulo: O follow-up preenche telefone e e-mail e nunca mais envia a variável crua
---
As mensagens de follow-up (texto fixo, legenda de mídia e modelo de mensagem) já preenchiam `{{nome}}` e `{{primeiro_nome}}`. Agora preenchem também `{{telefone}}` e `{{email}}`, e aceitam `{{contact.name}}`, `{{contact.phone_number}}` e `{{contact.email}}` como sinônimos. Antes, qualquer variável fora do nome chegava ao contato do jeito que foi escrita, com as chaves.

Variável sem valor sai da frase com a pontuação ajustada, como já acontecia com o nome. Variável que não existe (erro de digitação como `{{nomee}}`, ou um campo que não está na lista) também sai da mensagem em vez de chegar crua, e o editor do fluxo avisa na hora, embaixo do texto. Se a mensagem ficaria vazia, o passo é pulado e o fluxo segue.

A lista é fechada de propósito: CPF, data de nascimento, observações, campos personalizados e dados do negócio (como o título) não podem ser colocados numa mensagem por variável.

Você não precisa fazer nada. Vale revisar os textos dos seus fluxos: o editor mostra a lista de variáveis e aponta as que não existem.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2695, contribuição de @webtecnica).
