---
impacto: exige_acao
secao: corrigido
titulo: Nenhum contato é anonimizado por pedido de LGPD sem a aprovação registrada de um administrador
---
Anonimizar um contato não tem volta. Até aqui, o que fazia o sistema anonimizar era a chegada de um aviso interno ("pedido de anonimização recebido"), e o sistema não conferia se alguém tinha aprovado aquele pedido. Duas consequências:

- o pedido de apagamento que vinha da loja Nuvemshop era executado na hora, sem nenhuma pessoa decidir; o pedido de "apagar a loja inteira" anonimizava todos os contatos da organização do mesmo jeito;
- um pedido registrado à mão ficava protegido só pelo fato de ninguém disparar esse aviso antes da hora. Uma automação, um reprocessamento ou uma função nova que o disparasse anonimizaria o paciente sem aprovação.

Agora a aprovação fica gravada no próprio pedido: quem aprovou, quando, com qual justificativa, para qual pedido e qual contato. Antes de anonimizar, o sistema confere esse registro em dois pontos (no processo que executa o pedido e dentro do banco, na operação que apaga os dados) e exige que quem aprovou seja administrador daquela organização. Sem isso nada é apagado, venha o aviso de onde vier.

O pedido sem aprovação não se perde e não vira "Falhou": continua "Recebido" em LGPD › Solicitações, com o prazo contando e o alarme de prazo valendo para ele, até um administrador abrir a página e aprovar.

Também ficou mais firme o registro do desfecho. Se a anonimização acontecer e o sistema não conseguir gravar "Concluído" (banco fora do ar naquele instante), ele tenta de novo sem anonimizar duas vezes e sem marcar como "não feito" o que foi feito. Dois cliques em "Aprovar" não anonimizam duas vezes.

## Requer atenção

Só para quem usa a integração com a loja Nuvemshop: os pedidos de apagamento que chegam da loja (de um cliente ou da loja inteira) deixam de ser executados sozinhos. Eles aparecem em LGPD › Solicitações como "Recebido", com prazo de 15 dias úteis, e precisam que um administrador abra o pedido e clique em "Aprovar anonimização", com justificativa. Passe a olhar essa tela, ou o prazo legal vence sem o apagamento. Quem não tem loja conectada não precisa fazer nada.
