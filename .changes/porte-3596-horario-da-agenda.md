---
impacto: capacidade_nova
secao: adicionado
titulo: Conferência de horário da agenda, em observação
---

Uma nova conferência antes do envio compara cada dia e horário que o assistente
escreve ao cliente com o que a agenda devolveu. Numa resposta em que ele
consultou a agenda, todo horário com data precisa ter vindo dessa consulta ou
ser um compromisso que o cliente já tem. Sem consulta, só o horário que ele
oferece ("tenho 05/11 às 10h") é conferido. A mesma conferência pega "está
agendado" ou "está confirmado" quando nenhuma marcação foi gravada naquela
resposta.

Nesta versão ela entra em observação: não barra nada, e a mensagem sai como
antes. O registro de cada envio (`before_send_traces`) anota o que ela teria
barrado, como `observado:horario_sem_fonte` ou
`observado:agenda_confirmou_sem_marcar`. A regra ainda erra em frases comuns de
recusa, de lembrete e de duração, e o bloqueio só deve ser ligado depois de
medir esses registros em conversas reais.

Falar do compromisso que o cliente já tem não conta. Duração, horário de
chegada, horário de funcionamento, faixas como "das 8h às 18h" (e o fim de
"14h às 15h"), término previsto, eventos, promoções, horário de remédio,
resultados e confirmação de pagamento não são conferidos. Recusar o horário que
o cliente pediu ("às 15h não tenho vaga, mas tenho às 16h") passa, e o horário
oferecido no lugar continua conferido. No repasse da resposta de um caso, só a
afirmação de que está agendado é conferida: o horário que a equipe combinou fora
da agenda pode ser repassado.

Para ligar o bloqueio, ponha `HORARIO_DA_AGENDA_MODO=barrar` no `.env` e recrie o
app e o worker. Barrando, o assistente refaz a resposta; se insistir, ela sai
sem horário, ou só com o horário marcado naquela resposta, ou, na confirmação,
só com o compromisso que o cliente já tem. O motivo aparece na linha do tempo
do lead e no aviso do Inbox. A conferência aparece no painel Segurança do
agente e só vale para agentes com ferramenta de agenda. Nada precisa ser feito
na instalação para atualizar.

Portado do projeto original (DeskcommCRM, PR #3596 de @fillipeagra-cyber), adaptado.
