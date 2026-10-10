---
impacto: nada_mudou
secao: corrigido
titulo: "Sugerir resposta" e "Testar" passam a respeitar o horário de resposta, não o de disparo
---
Fora do horário de disparo (por padrão, antes das 7h e depois das 22h), o botão "Sugerir resposta" da conversa e o "Testar" do agente falhavam por estarem fora da janela de envio, mesmo com a conexão configurada para responder 24 horas. A sugestão é resposta a uma mensagem que o cliente mandou, então agora vale o horário de resposta da conexão, o mesmo já usado quando a resposta aprovada é enviada. O horário de disparo de campanhas e de retomadas não muda. Nada precisa ser feito ao atualizar.
