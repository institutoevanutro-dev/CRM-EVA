---
impacto: capacidade_nova
secao: adicionado
titulo: Tarefas dentro do card do negócio, com responsável, e selo de pendências no quadro
---
Até aqui a tarefa só nascia na tela de Tarefas, que não pergunta de qual negócio ela é: toda tarefa feita à mão ficava avulsa. Agora o painel que abre ao clicar num card do funil tem a seção **Tarefas**, antes da linha do tempo. O botão **Nova tarefa** cria a tarefa já presa àquele negócio e ao contato dele, com quem criou como responsável (dá para trocar por qualquer pessoa da equipe e pôr prazo). Dali mesmo dá para concluir, reabrir, editar e apagar. No quadro, o card passa a mostrar um selo discreto com o número de tarefas em aberto daquele negócio; ele fica vermelho, com um aviso e o número das vencidas, quando alguma passou do prazo, e some quando não há nada em aberto. O card não cresce. Na tela de Tarefas, que continua igual e mostra as mesmas tarefas, cada linha ganha o nome do negócio, com atalho para ele. Editar uma tarefa não reenvia mais um responsável em que ninguém mexeu, então dá para corrigir o título de uma tarefa cujo responsável saiu da equipe. Em tela de toque, os botões de editar e apagar da linha ficam sempre à vista.

Quem vê o quê mudou junto: a tarefa presa a um negócio passa a seguir a visibilidade do negócio. Gestor, administrador e somente leitura seguem vendo todas. O atendente vê as tarefas dos negócios que ele enxerga, as avulsas e as que são dele. O prestador de serviço vê só as tarefas dos negócios dele e as que foram dadas a ele (antes via todas). Criar e mexer em tarefa continua sendo de atendente para cima. A atualização aplica a migration 0359 sozinha; nada a fazer na VPS.

Porte do upstream melgarafael/DeskcommCRM#2760 (contribuição de @profpeque), adaptado ao que este sistema já tinha (responsável na tarefa e tarefa na linha do tempo do negócio).
