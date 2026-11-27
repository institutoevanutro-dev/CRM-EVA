---
impacto: capacidade_nova
secao: alterado
titulo: Agenda redesenhada — hora com relógio, painel do paciente e semana de segunda a sábado
---
No "Novo agendamento", a hora ganhou um campo com relógio embaixo do calendário, com os horários
livres logo abaixo como atalho. Uma hora digitada que não está entre os horários livres mostra o
aviso "Fora dos horários livres". Há também um seletor "Paciente novo / Paciente antigo": em
paciente antigo, "Quem converteu" e "Origem do lead" somem e nenhuma conversão é gravada.
O topo da Agenda cabe numa linha só. A fileira de profissionais fica ao lado de "Horários livres
de", mostra só quem tem atendimento na semana e escolhe uma pessoa por vez. A semana e o mês vão
de segunda a sábado; o domingo aparece só quando tem algo marcado ou quando é hoje. Os cartões ficaram mais limpos: a cor do profissional numa faixa, o nome do paciente e
"hora · procedimento". As linhas da grade ficaram mais leves, e os horários bloqueados aparecem
listrados, com o nome de quem bloqueou quando a grade mostra mais de uma pessoa. Clicar numa consulta abre o painel do paciente, com Remarcar e Cancelar enquanto ela está
agendada (consulta realizada ou com falta não se cancela); "Confirmar" só aparece enquanto a
consulta espera confirmação, e cada decisão confirma num aviso curto. "Compareceu" e "Faltou" também ficam nesse
painel, depois do horário de início. Google, Meet, contato e anotações ficam em "Mais detalhes", que
abre sozinho quando a sincronização com o Google ou o link do Meet falham. A lista de baixo da Agenda, que tinha o "Faltou", saiu.
Para integrações: o `POST /api/v1/agenda/agendamentos` agora aceita `converted_by_kind: null`
(sem conversão); ausente continua gravando quem marca. Nada muda no banco nem na instalação.
