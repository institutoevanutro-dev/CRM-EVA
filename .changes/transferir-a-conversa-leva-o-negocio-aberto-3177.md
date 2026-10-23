---
impacto: capacidade_nova
secao: corrigido
titulo: Transferir a conversa leva junto o negócio aberto do contato, e assumir dá dono ao negócio sem responsável
---
Ao transferir uma conversa no Inbox para outra pessoa, só o responsável da conversa mudava: o negócio aberto daquele contato no funil continuava com o responsável antigo, ou sem nenhum, e quem recebeu o atendimento não achava o card no filtro "Responsável". Agora a transferência também passa o negócio aberto do contato para a nova pessoa, como se a troca fosse feita na tela do negócio. Se o contato tem mais de um negócio aberto, nenhum é alterado (escolher entre eles fica com a equipe); sem negócio aberto, nenhum card é criado; e se o card já era de quem passou a atender, nada é regravado. Assumir a conversa (inclusive por "Iniciar conversa" e "Continuar por outro número") só dá dono a um negócio aberto que ainda não tem responsável: nunca tira o card de um colega nem de um agente de IA. A regra de visibilidade do funil continua valendo: na visibilidade padrão (cada atendente vê os seus e os sem responsável), quando uma atendente transfere para outra, o negócio não vai junto, porque pela tela do funil ela também não poderia passá-lo; vai junto quando quem transfere é gerente ou administrador, ou quando todos veem tudo. Quando o negócio muda de responsável por aqui, sai o mesmo aviso e o mesmo evento de "negócio atribuído" da troca pela tela, inclusive para webhooks e automações que escutam esse evento. Nada a fazer na atualização.

Portado do projeto original (DeskcommCRM, PR #3216 de @webtecnica).
