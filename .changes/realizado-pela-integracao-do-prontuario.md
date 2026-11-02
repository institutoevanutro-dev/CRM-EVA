---
impacto: capacidade_nova
secao: adicionado
titulo: Integração do prontuário pode marcar o compromisso como realizado
---

Quando o profissional finaliza a consulta no prontuário, a integração pode registrar o
compromisso como "Realizado" na Agenda, sem alguém repetir o clique. Para isso há um escopo
novo de chave, `agenda:outcome` ("Prontuário: marcar compromisso como realizado"), que abre
só a ferramenta `crm_set_appointment_outcome` e só para o desfecho `completed`.

A porta é estreita: não registra falta, não remarca, não cancela, só alcança compromisso da
organização da chave que já começou, e repetir a chamada não muda nada. O compromisso fica
com a origem "integração" (não finge ser uma pessoa), e a auditoria guarda a chave e o nome do
profissional informado (`performed_by_name`). O acompanhamento pós-consulta dispara igual ao
da presença confirmada pela equipe. Quem não cria uma chave com esse escopo não vê diferença.
