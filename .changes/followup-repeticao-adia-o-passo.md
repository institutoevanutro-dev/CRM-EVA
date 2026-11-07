---
impacto: nada_mudou
secao: corrigido
titulo: Mensagem de follow-up barrada por repetição é adiada em vez de encerrar a sequência
---

Quando vários contatos recebiam o mesmo passo de texto fixo na mesma hora (por exemplo, um passo marcado para o dia da consulta, que sai para todos na abertura da janela), a trava contra mensagens repetidas barrava a terceira cópia quase igual, e o sistema encerrava a sequência inteira daquele contato, com todos os passos seguintes. Agora, quando só a trava de repetição barra o envio, o passo é adiado de 5 a 30 minutos e, se tiver variações de texto, a nova tentativa usa a variação seguinte. São até 3 adiamentos; depois disso a sequência é encerrada, como antes. Os horários de envio continuam valendo, e um envio barrado por qualquer outra regra continua encerrando a sequência como antes.
