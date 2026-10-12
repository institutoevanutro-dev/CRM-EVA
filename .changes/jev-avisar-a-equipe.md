---
impacto: capacidade_nova
secao: adicionado
titulo: Jev pode avisar a equipe quando percebe um pedido que a regra não viu
---
No cartão do Jev (IA › Provedores), as tarefas "Pedido para falar com uma pessoa" e "Pedido para parar de receber mensagens" ganharam um terceiro estado, "Avisar a equipe". Com ele, quando a regra do sistema não viu o pedido e o Jev viu com confiança alta, abre um aviso na Central para alguém da equipe conferir, um por conversa. É só isso: o Jev não bloqueia contato, não transfere a conversa, não cala o assistente e não manda mensagem. Quem bloqueia e quem transfere continua sendo a regra de sempre. O clima da conversa segue só observando.

Nada muda até um administrador trocar o estado de uma tarefa no cartão, e a troca pede confirmação. Para voltar, um clique em "Observando" na mesma linha. Toda troca fica na auditoria. Nada novo é enviado à TypeSafe: é a mesma última mensagem, limpa, que o Jev já recebia para observar.

Entra também um teste de frases, sem dado de paciente: 80 frases escritas à mão, enviadas ao Jev de dentro do contêiner do worker, com o placar de acertos e erros por tarefa (`scripts/jev-teste-de-frases.ts`).

Você não precisa fazer nada.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#1747).
