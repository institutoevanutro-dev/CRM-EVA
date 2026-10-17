---
impacto: nada_mudou
secao: corrigido
titulo: Nome do perfil do WhatsApp nas mensagens, resposta cortada da IA avisada na Central, prévias de mídia em português e outras correções
---

Portado do projeto original (DeskcommCRM):

- `{{nome}}` e `{{primeiro_nome}}` nas automações (WhatsApp e e-mail) e nas
  respostas prontas do integrador usam o nome do perfil do WhatsApp quando o
  contato não tem nome cadastrado. Sem nome nenhum, a variável sai com a
  pontuação em volta, como no acompanhamento: "Olá, tudo bem?", nunca
  "Olá , tudo bem?" (PR #2374 de @melgarafael e PR #3017 de @webtecnica);
- quando a resposta da IA passa do tamanho máximo, a mensagem cortada nunca é
  enviada ao paciente, e se nem a nova tentativa automática responder, abre um
  aviso na Central de avisos ligado à conversa, para alguém da equipe
  responder. Antes o paciente ficava sem resposta e ninguém sabia (PR #2938 de
  @guptasp82-jpg; o aviso na Central e o conserto da nova tentativa, que caía
  com erro quando o corte pegava a IA no meio de um envio, são adaptações
  nossas);
- a publicação de um acompanhamento com a caixa Repetir conta as voltas que
  ela permite: um fluxo que morreria no meio (mais de 80 passos no motor) é
  recusado na publicação, com a caixa e as voltas nomeadas. Fluxos já
  publicados não mudam (PR #3022 de @webtecnica);
- a condição "contém" das regras automáticas ignora acento e pontuação nos
  dois lados: "anúncio" casa "anuncio", "Olá!" casa "ola". "É igual a" segue
  exato (PR #3028 de @webtecnica);
- a lista de conversas mostra "Imagem", "Áudio", "Vídeo", "Documento" no lugar
  de [image], [audio], [video], [document] quando a mensagem não tem texto.
  As prévias já gravadas mudam na próxima mensagem da conversa (PR #2850 de
  @webtecnica);
- "cancelar a assinatura" (e "cancelar la suscripción") chama uma pessoa da
  equipe em vez de bloquear o contato, porque pode ser o plano e não as
  mensagens. Com o objeto ("cancelar a assinatura das mensagens") continua
  bloqueando na hora (PR #2971 de @webtecnica);
- o CSV da auditoria e o CSV de uso da Administração neutralizam texto que
  começa com =, +, -, @, para não virar fórmula ao abrir no Excel (PR #3001 de
  @melgarafael).

Correção nossa (CRM EvaLink): o prazo dos pedidos de titular da LGPD salta o
20 de novembro (Dia Nacional de Zumbi e da Consciência Negra), feriado
nacional desde 2024 pela Lei 14.759/2023.

Nada a fazer na VPS: nenhuma migration, nenhuma variável nova.
