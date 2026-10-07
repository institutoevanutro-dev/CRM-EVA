---
impacto: nada_mudou
secao: corrigido
titulo: O follow-up espera o horário de envio abrir sem desistir do paciente
---
Quando uma mensagem de follow-up caía fora do horário de envio — de noite, no fim de semana, ou fora do horário que a clínica escolheu —, o sistema já guardava a mensagem para a próxima abertura. O problema era que o fluxo não ficava sabendo disso: ficava perguntando "essa mensagem já saiu?" e, depois de umas onze horas, desistia do paciente e mostrava o aviso "Um fluxo de follow-up parou de tentar". Uma sexta à noite até a segunda de manhã já passava desse limite.

Agora o fluxo sabe que está esperando o horário e até quando. Ele fica parado no mesmo passo até a abertura, manda a mensagem e segue normalmente. No histórico do follow-up aparece a linha "Segurou o envio até o horário permitido", com a data. Se o envio travar de verdade, sem sinal nenhum, o sistema continua desistindo e avisando como antes.

Não é preciso fazer nada. Pacientes cujo fluxo já tinha parado por esse motivo não voltam sozinhos; a correção vale daqui para frente.
