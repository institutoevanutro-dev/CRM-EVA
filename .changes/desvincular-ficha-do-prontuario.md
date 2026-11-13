---
impacto: capacidade_nova
secao: adicionado
titulo: Dá para desfazer o vínculo errado entre um contato e a ficha do Prontuário
---

Quando o Prontuário ligava a ficha de um paciente ao contato errado (um duplicado, por exemplo), não havia como desfazer pela tela nem pela API, e ligar a ficha ao contato certo falhava com conflito. Agora a ficha do contato mostra a linha **Prontuário: Ficha vinculada** quando há vínculo, e gestores e administradores veem o botão **Desvincular do Prontuário**, com confirmação. Desvincular só apaga a ligação: nada é apagado no contato nem no Prontuário, e a ficha pode ser ligada ao contato certo em seguida. A ação fica no registro de auditoria (`prontuario.contact_unlinked`) com a cópia do vínculo removido. A API ganhou `DELETE /api/v1/contacts/{id}/prontuario-link`, que aceita sessão (gestor ou acima) ou token com o escopo `prontuario:contacts:write` — o mesmo que cria o vínculo, para o Prontuário poder corrigir a própria ligação. Sem mudança no banco.
