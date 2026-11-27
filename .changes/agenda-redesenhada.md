---
impacto: capacidade_nova
secao: alterado
titulo: Agenda redesenhada — hora com relógio, painel do paciente e semana de segunda a sábado
---
No "Novo agendamento", a hora ganhou um campo com relógio ao lado da data, com os horários livres
embaixo como atalho, e um seletor "Paciente novo / Paciente antigo": em paciente antigo, "Quem
converteu" e "Origem do lead" somem e nenhuma conversão é gravada. A fileira de profissionais
mostra só quem tem atendimento na semana e escolhe uma pessoa por vez. A semana e o mês vão de
segunda a sábado; o domingo aparece só quando tem algo marcado. Os cartões ficaram mais limpos:
a cor do profissional numa faixa, o nome do paciente e "hora · procedimento". Clicar numa consulta
abre o painel do paciente, com Confirmar, Remarcar e Cancelar, e a lista de baixo da Agenda saiu.
Para integrações: o `POST /api/v1/agenda/agendamentos` agora aceita `converted_by_kind: null`
(sem conversão); ausente continua gravando quem marca. Nada muda no banco nem na instalação.
