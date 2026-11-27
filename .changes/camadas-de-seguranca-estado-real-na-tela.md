---
impacto: nada_mudou
secao: corrigido
titulo: A tela de segurança do agente mostra ligadas as verificações que o agente já roda
---
Quando a organização nunca tinha escolhido, o painel de segurança do agente
mostrava a verificação de promessa e a de manipulação como desligadas, mas o
agente rodava as duas: a de promessa vem ligada por padrão
(`PROMISE_SEMANTIC_ENABLED` ausente = ligada, só `false` desliga) e a de
manipulação roda mesmo sem `JAILBREAK_CLASSIFIER_MODEL`, que só escolhe o modelo.
Quem testava o agente via a mensagem vetada por uma verificação que a tela dizia
estar desligada. Agora a tela lê o padrão pela mesma regra do agente e diz
"Ligada — vem da configuração do servidor". O comportamento do agente não muda.
Nada a fazer na atualização.
