---
impacto: capacidade_nova
secao: adicionado
titulo: Contato pode ser marcado como "Sempre atendimento humano", e outras correções vindas do projeto original
---

Na ficha do contato há um botão novo, "Sempre atendimento humano". Com a marca
ligada, a IA para na hora e nunca mais responde aquele contato: nem no
atendimento, nem no roteador, nem por follow-up, nem pela automação que escreve
com IA, nem mandando link da agenda. O botão "Devolver ao automático" passa a
recusar esse contato. A equipe continua respondendo normalmente, e os lembretes
de consulta continuam saindo. Tirar a marca não devolve o atendimento à IA:
isso continua sendo o botão "Devolver ao automático". Quem marca ou desmarca
fica registrado na auditoria.

Também entram, portados do projeto original:

- a resposta da IA depois de usar uma ferramenta deixa de falhar com
  "Invalid signature in thinking block" nos modelos que raciocinam;
- as classificações que rodam antes de cada resposta (estágio da conversa e
  tentativa de manipulação) pedem ao modelo que não raciocine, e a resposta
  chega mais rápido;
- "tem vaga dia 05?" com um período junto deixa de voltar vazio: o período
  começa no dia pedido;
- a IA não confirma mais um retorno combinado ("retomamos daqui a duas horas")
  sem deixar o follow-up agendado;
- Claude Haiku 5.5, Sonnet 5.5 e Opus 5.5 aparecem na lista de modelos, com o
  custo contado no orçamento. Nenhum agente troca de modelo sozinho;
- na Inbox, `{{primeiro_nome}}` digitado à mão sai com o nome do cliente;
- renomear uma etiqueta para um nome que já existe junta as duas sem perder a
  cor, e a tela avisa antes.

Nada a fazer na VPS: a atualização aplica as migrations 0366, 0367 e 0368.
