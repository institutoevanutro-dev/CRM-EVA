---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode passar a conversa para outro assunto do roteador
---
Roteadores ganham um modo opcional em que a troca de agente no meio da conversa deixa de ser decidida mensagem a mensagem. Com ele ligado, o roteador escolhe quem começa a conversa e só interrompe um atendimento em andamento para os assuntos marcados como urgentes; fora disso, é o próprio agente que passa a conversa para outro assunto, e o agente de destino responde a mesma mensagem, sem o cliente precisar repetir. Nesse modo o classificador também vê as últimas mensagens da conversa, que passam a ser enviadas ao provedor de IA configurado para o roteador. O teste do roteador aceita uma conversa simulada pela API. Roteadores que não ligarem o modo novo continuam exatamente como estavam; nada precisa ser feito ao atualizar. A mensagem em que há passagem é processada por dois agentes, então custa e demora mais que uma mensagem comum.
