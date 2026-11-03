---
impacto: nada_mudou
secao: corrigido
titulo: O assistente só oferece horário que a agenda devolveu
---

Uma nova conferência antes do envio compara cada dia e horário que o assistente
escreve ao cliente com o que a agenda devolveu. Numa resposta em que ele
consultou a agenda, todo horário com data precisa ter vindo dessa consulta ou
ser um compromisso que o cliente já tem. Sem consulta, só o horário que ele
oferece ("tenho 05/11 às 10h") é conferido.

A mesma conferência barra "está agendado" ou "está confirmado" quando nenhuma
marcação foi gravada naquela resposta. Falar do compromisso que o cliente já
tem continua livre. Duração, horário de chegada, horário de funcionamento,
faixas como "das 8h às 18h" (e o fim de "14h às 15h"), término previsto,
eventos, promoções, horário de remédio, resultados e confirmação de pagamento
não são conferidos. Recusar o horário que o cliente pediu ("às 15h não tenho
vaga, mas tenho às 16h") passa, e o horário oferecido no lugar continua
conferido. No repasse da resposta de um caso, o dia e horário que a equipe
escreveu na nota contam como vindos da agenda.

Quando barra, o assistente refaz a resposta. Se insistir, a resposta sai sem
horário, ou, depois de uma marcação de verdade, só com o horário marcado. A
conferência aparece no painel Segurança do agente, e o motivo aparece na linha
do tempo do lead e no aviso do Inbox. Só vale para agentes com ferramenta de
agenda. Nada precisa ser feito na instalação.

Portado do projeto original (DeskcommCRM, PR #3596 de @fillipeagra-cyber), adaptado.
