---
impacto: nada_mudou
secao: corrigido
titulo: A IA para de responder duas vezes ou de mandar resposta atrasada
---

Quando o paciente escreve em várias mensagens seguidas ("Oi", "Boa tarde" e
depois a pergunta), a IA às vezes mandava "Como posso ajudar?" com a pergunta
já na conversa, e logo depois respondia de novo. Outras vezes a mesma
mensagem do paciente recebia duas respostas quase iguais.

Agora, se o paciente escreve de novo enquanto a IA ainda está preparando a
resposta, essa resposta desatualizada não é enviada: a IA lê a conversa
inteira e responde a tudo de uma vez. E se uma resposta já cobriu a última
mensagem do paciente, a IA não responde a ela uma segunda vez.

Para quem escreve sem parar não ficar sem resposta, essa espera vale só
enquanto a mensagem mais antiga sem resposta tiver menos de 2 minutos. Depois
disso a resposta sai mesmo assim. E nos últimos minutos antes de fechar o
horário de envio (ou o horário de atendimento do agente), a resposta também sai
mesmo assim, para o paciente não esperar até o dia seguinte. Nenhuma
configuração é necessária.

Portado do projeto original (DeskcommCRM, trabalho de Elias Gervanno,
automatikpg-ux e melgarafael).
