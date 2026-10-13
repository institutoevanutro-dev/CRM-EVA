---
impacto: nada_mudou
secao: corrigido
titulo: Paciente que escreve de novo enquanto uma resposta está sendo reenviada não fica mais sem resposta
---
Quando a IA manda uma resposta em mais de uma mensagem e o envio falha no meio (o WhatsApp recusa uma delas, ou o serviço reinicia), o sistema espera de 10 segundos a 2 minutos e tenta de novo. Se o paciente escrevesse outra mensagem exatamente nessa espera, ela era juntada à tentativa que já estava na fila. Na hora de reenviar, o sistema tratava a primeira mensagem da nova resposta como "já enviada" e não mandava: o paciente recebia só o começo da resposta antiga e nada sobre o que acabou de perguntar. Não aparecia erro nem aviso na Central.

Agora a mensagem nova ganha o próprio atendimento, que lê a conversa inteira e responde. A tentativa antiga não fala por cima dela: se a resposta antiga ficou desatualizada, ela é descartada, como já acontecia quando o paciente escreve enquanto a IA está pensando.

Nada muda no resto: mensagens seguidas mandadas antes de a IA responder continuam virando uma resposta só, o ritmo de envio é o mesmo, e conversa assumida por uma pessoa, silenciada ou de quem pediu para não receber continua sem resposta automática.
