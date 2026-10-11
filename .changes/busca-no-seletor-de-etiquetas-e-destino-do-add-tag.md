---
impacto: capacidade_nova
secao: adicionado
titulo: Busca dentro do filtro de etiquetas do Inbox, e automação que pode etiquetar o contato
---
O filtro de etiquetas do Inbox ganhou um campo de busca dentro do próprio menu. Quem tem muitas etiquetas digita um pedaço do nome e a lista encolhe na hora, sem esperar o servidor. As etiquetas já marcadas e a escolha entre "Todas (E)" e "Qualquer uma (OU)" continuam como estavam enquanto se digita, e a busca é limpa ao fechar o menu. Quando nada combina, o menu diz "Nenhuma etiqueta com esse texto".

Na ação "Adicionar tag" das automações agora dá para escolher o destino: o card, que é o comportamento de sempre e continua sendo o padrão, ou o contato do lead, que é uma das caixas que o filtro do Inbox consulta. Com "Contato do lead", as etiquetas que o contato já tem são preservadas, e se o lead não tiver contato a ação é ignorada em vez de marcar o card no lugar.

Nada precisa ser feito ao atualizar. As automações que já existem não têm o campo novo e continuam marcando o card.

Portado do projeto original (DeskcommCRM #2701, de @webtecnica, a partir da issue #2498 de @vagnerrm122). A mudança de ordem das abas do Inbox que vinha no mesmo pacote não foi trazida: aqui as abas já foram reorganizadas em Fila, Minhas, Todas e "Mais".
