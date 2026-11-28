---
impacto: capacidade_nova
secao: adicionado
titulo: O paciente confirma a presença respondendo SIM ao lembrete
---
Em Configurações › Tipos de agendamento, o lembrete do tipo ganhou a chave "Pedir confirmação no
lembrete", desligada por padrão. Ligada, a mensagem termina com "Para confirmar sua presença,
responda SIM.", e a prévia já mostra o texto final. Quando o paciente responde só "SIM" (ou
"confirmo", "👍"…) logo depois do lembrete, o compromisso continua "Agendado" e ganha a marca
"Presença confirmada". O CRM não responde nada: só lê. Qualquer outra resposta ("sim, mas…",
"não", "remarcar") segue para o agente ou a equipe como antes, e um "sim" depois de outra mensagem
da clínica não conta. Remarcar o horário apaga a confirmação, e o lembrete seguinte pede de novo.
Na Agenda, o cartão mostra um check duplo para quem confirmou e um sino "Lembrete sem resposta"
para quem recebeu o pedido e não respondeu, os dois explicados na legenda. O painel do paciente
diz "Presença confirmada · pelo WhatsApp em 26/11 às 14:32" ou "· pela equipe", com o nome de quem
marcou, e ganhou o botão "Paciente confirmou" para a confirmação por telefone, que aparece só em
compromisso agendado, com paciente e antes do horário. A confirmação entra na timeline do negócio
e na auditoria (`agenda.paciente_confirmou`), e o agente de IA passa a ver no bloco de
compromissos que o paciente já confirmou.
Para integrações: o `PATCH /api/v1/agenda/agendamentos` aceita `{ id, revision, patient_confirmed:
true }` (papel `agent` ou acima) e responde 409 `appointment_patient_confirmation_not_applicable`
quando o compromisso não aceita a marca; a API dos tipos aceita `reminder_asks_confirmation`. A
atualização aplica a migration 0441 pelo caminho de sempre, sem passo manual.
