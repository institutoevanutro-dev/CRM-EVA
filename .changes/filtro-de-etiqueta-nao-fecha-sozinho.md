---
impacto: nada_mudou
secao: corrigido
titulo: O filtro de etiqueta do Inbox para de fechar sozinho
---

Ao abrir o filtro "Filtrar por tag" no Inbox, a lista de etiquetas às vezes se
fechava sozinha uma fração de segundo depois de aparecer, e o clique na
etiqueta não pegava. Acontecia quando a lista de etiquetas da organização
estava sendo relida em segundo plano, o que é justamente o que o sistema faz
logo depois de alguém marcar uma conversa.

O filtro agora continua na tela enquanto a lista é relida. Quem ainda não criou
nenhuma etiqueta segue sem o filtro, como antes.

Correção portada do projeto original (DeskcommCRM, issue #1336).
