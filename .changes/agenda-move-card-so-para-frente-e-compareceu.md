---
impacto: capacidade_nova
secao: adicionado
titulo: A agenda leva o card para "Compareceu" e nunca mais o devolve a uma etapa anterior
---
Quando a recepção registra que o paciente compareceu, o card passa a ir sozinho para a etapa
"Compareceu" do funil (a etapa criada com esse nome; o código dela é `compareceu`). Se essa
etapa for de ganho, o card que já estava ganho no sinal também segue para ela; um card ganho
nunca é reaberto pela agenda, e um card perdido não se mexe. Marcar ou confirmar uma consulta
continua levando o card às etapas `agendamento-solicitado` e `agendado`, mas agora só para
frente: o card que já passou dessa etapa fica onde está. A agenda também passou a achar o card
certo quando o paciente tem mais de um, por exemplo um de protocolo aberto ao lado do de
atendimento. Funil sem essas etapas segue sem mudança nenhuma.
