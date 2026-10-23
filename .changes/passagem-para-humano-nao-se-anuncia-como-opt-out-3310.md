---
impacto: nada_mudou
secao: corrigido
titulo: A conversa passada para a equipe não é mais registrada como opt-out nem como pedido do cliente
---
O aviso de resposta não enviada já dizia "a conversa está com a equipe" em vez de opt-out desde a versão de 11/10. Faltavam dois lugares. O primeiro era o link de reunião do Google Meet: quando a conversa estava com a equipe (inclusive para contatos marcados como "Sempre atendimento humano"), a entrega era registrada como barrada por uma "trava de segurança" genérica; agora fica registrada como barrada porque a conversa está com a equipe. O segundo era o motivo da passagem: quando a própria IA decidia passar a conversa para uma pessoa sem dizer por quê (faltou informação, ou a regra do prompt mandava), o motivo era gravado como "o cliente pediu uma pessoa", e era isso que aparecia no aviso da Central. Agora fica gravado como "a IA não resolveu sozinha", e o pedido do cliente continua aparecendo como pedido quando ele de fato pediu. O mesmo vale para agentes externos ligados pelo MCP. A IA continua parada nessas conversas exatamente como antes, até alguém usar "Devolver ao automático". Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3318 de @webtecnica), partes 1 e 2. No CRM da clínica a distinção da conversa com a equipe já existia com outro código (`conversa_com_humano`).
