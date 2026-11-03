---
impacto: nada_mudou
secao: corrigido
titulo: Confirmação sem agendar é conferida, remarcação não duplica e turno mudo se corrige
---

Uma resposta que abre a frase com "Confirmado", "Agendado" ou "Marcado", com dia e
horário, agora é conferida antes do envio quando nada foi marcado naquela resposta,
mesmo que o assistente tenha consultado a agenda — também quando o dia e o horário
vêm no cartão das linhas de baixo (📅 e 🕒). O mesmo vale para "Remarcado", "troca
feita" ou "foi alterada para" quando a remarcação não foi gravada. Confirmar a
presença ou lembrar um horário que o cliente já tem deveria passar; lembrete
com duração ou com oferta de retorno na mesma frase ainda é pego quando o
bloqueio está ligado. A regra
mora na conferência de horários da agenda, a mesma que aparece no painel
Segurança do agente, e entra em observação junto com ela: só barra com
`HORARIO_DA_AGENDA_MODO=barrar`.

As descrições das ferramentas de agenda passam a mandar a remarcação mover o mesmo
compromisso, em vez de marcar um segundo e deixar o antigo no lugar.

Quando um envio é recusado por uma regra de texto e a resposta termina sem nenhuma
mensagem ao cliente, o assistente recebe uma única nova tentativa, agora com passos
suficientes para consultar a agenda e responder. Nada é tentado de novo quando o
contato pediu para sair, é interno, está com a equipe ou foi anonimizado, quando a
janela de envio fechou, quando a resposta ficou desatualizada porque o cliente
escreveu de novo, ou quando a guarda de repetição barrou a mensagem. A orientação
de remarcar dessa nova tentativa só vai aos agentes que listam e remarcam
compromissos. Nada precisa ser feito na instalação.

Portado do projeto original (DeskcommCRM, PR #3673 de @victor-will), adaptado.
