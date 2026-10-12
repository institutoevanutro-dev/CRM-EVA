---
impacto: nada_mudou
secao: corrigido
titulo: Editar um campo do rascunho do agente pela API não zera mais os outros
---
Uma edição parcial de rascunho pela API (`PATCH /api/v1/ai/agents/{id}/versions/{vid}`) com um campo só, por exemplo o prompt, gravava o valor padrão em tudo o que não foi enviado: a lista de ferramentas ficava vazia, casos, bolhas curtas e follow-up eram desligados e o limite de passos voltava a 10. Publicado assim, o agente atendia sem ferramenta nenhuma e dizia ter marcado consulta sem marcar. Agora só o que vem no corpo é gravado, e o resto do rascunho fica como estava. Um corpo vazio volta a ser recusado.

A mesma rota aceitava os campos do papel Operador, dos funis e dos materiais, respondia com sucesso e não gravava nenhum. Agora grava, com a mesma conferência de organização que a criação de versão já fazia.

Quem edita pela tela não foi afetado: o editor sempre envia o agente inteiro. Se você editou um rascunho por integração ou script e publicou, abra o agente e confira as ferramentas e o follow-up.
