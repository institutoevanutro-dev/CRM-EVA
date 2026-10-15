---
impacto: capacidade_nova
secao: adicionado
titulo: Excluir da Agenda um agendamento de teste ou lançado por engano
---

No detalhe de um agendamento, gerente e admin passam a ver "Excluir (lançado por
engano)". Um diálogo pede o motivo e avisa que é só para teste ou engano; para
paciente que desmarcou, o caminho continua sendo "Cancelar agendamento". O
agendamento excluído sai da grade, das listas (Próximos, Aguardando confirmação,
Passados e Cancelados), da visão do contato e do negócio, das ferramentas da IA,
dos números de Início e do relatório de funil, e o horário fica livre. O evento do
Google sai como num cancelamento, mas nenhuma automação de "agendamento cancelado"
é disparada para o paciente. Nada é apagado: o registro fica no banco com quem
excluiu, quando e por quê, e a auditoria ganha a linha `agenda.appointment_excluded`.
