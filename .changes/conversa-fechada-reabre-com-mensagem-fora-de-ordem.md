---
impacto: nada_mudou
secao: corrigido
titulo: A conversa encerrada volta a reabrir quando a mensagem do paciente chega atrasada
---
Quando a mensagem do paciente chegava depois de a conversa ter sido encerrada, mas
com o horário de envio anterior ao encerramento (entrega atrasada do canal, lote do
provedor, relógio do celular atrasado), a conversa continuava encerrada com a
mensagem dentro: não aparecia na Fila e a equipe perdia o paciente sem erro em lugar
nenhum. Agora a conversa reabre e volta para a Fila, seja qual for a ordem em que a
mensagem chegou. O horário original continua ordenando a conversa, e o novo
atendimento nunca começa antes do fim do anterior. Reenvio da mesma mensagem não
abre atendimento novo, e uma segunda mensagem atrasada não reabre duas vezes. Na
atualização não há nada a fazer (migration 0412). Portado do projeto original
(DeskcommCRM, PR #3231 de @webtecnica).
