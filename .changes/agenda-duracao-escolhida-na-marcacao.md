---
impacto: capacidade_nova
secao: adicionado
titulo: A duração do atendimento pode ser escolhida na hora de marcar
---

No "Novo agendamento" da Agenda, depois do procedimento, aparece o campo **Duração (minutos)**, já preenchido com a duração do procedimento. Quem não mexer marca como sempre marcou. Mudando (por exemplo, 90 em vez de 45), a lista de horários passa a mostrar só os horários que têm esse tempo livre, o fim no resumo é recalculado e o compromisso nasce com essa duração. Os horários continuam nos mesmos pontos da grade; muda só quanto cada um precisa ter livre. Valores fora de 5 a 1440 minutos mostram o aviso e travam o Confirmar; trocar a duração limpa o horário escolhido. Remarcar mantém a duração que o compromisso já tinha. A IA continua marcando com a duração do procedimento. A API aceita `duration_minutes` no `POST /api/v1/agenda/agendamentos` e `duracao_minutos` em `GET /api/v1/agenda/horarios-livres`. Sem mudança no banco. Portado do projeto original (DeskcommCRM, PR #3714).
