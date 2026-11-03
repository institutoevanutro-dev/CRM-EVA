---
impacto: capacidade_nova
secao: alterado
titulo: "Sugerir resposta" propõe um texto quando o agente ficaria em silêncio
---

No Inbox, quando alguém clica em "Sugerir resposta" numa conversa com mensagem do
cliente ainda sem resposta e o agente, seguindo o próprio roteiro, ficaria em
silêncio, ele agora recebe um pedido explícito: uma pessoa da equipe pediu um texto
para essa conversa. A sugestão aparece para revisão, como qualquer outra.

Isso custa uma chamada a mais ao modelo, e só no clique. Quando uma regra de
conteúdo, de janela ou de ritmo recusa a resposta, quando a geração falha e quando
a conversa já foi respondida, a sugestão continua vazia, como antes. O texto
aprovado passa pelas mesmas conferências antes de sair, e nada é enviado sem a
aprovação de quem pediu.

O atendimento automático e os rascunhos que o agente escreve sozinho no modo
"Assistido: revisar antes de enviar" não mudaram. Nada precisa ser feito na
instalação.

Portado do projeto original (DeskcommCRM, PR #3557 de @webtecnica, issue #3281), adaptado: só no clique, sem a correção de texto solto da prévia (PR #3093), que este fork ainda não tem.
