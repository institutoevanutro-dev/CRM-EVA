---
impacto: nada_mudou
secao: corrigido
titulo: Parar ou atualizar o worker não o mata mais à força aos 5 segundos
---
Quando a VPS parava o worker (atualização, reinício ou `docker stop`), o
processo era morto à força uns 5 segundos depois. Se havia uma mensagem
saindo nesse momento, ela podia chegar ao WhatsApp sem que o worker anotasse
o envio: aparecia como presa e depois como falha, embora tivesse saído. Agora
o worker recebe o aviso de parada, não começa trabalho novo e termina o que
estava em andamento. Nenhuma configuração nova: a atualização leva a correção.

Porte de melgarafael/DeskcommCRM#2826 (contribuição de @webtecnica).
