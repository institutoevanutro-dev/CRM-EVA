---
impacto: nada_mudou
secao: corrigido
titulo: O funil por origem responde ao painel de anúncios
---

A rota do funil por origem, publicada na 4.34.0, era barrada pela checagem de sessão antes de conferir a chave do
painel, como acontecia com qualquer rota fora da lista. Agora ela segue o mesmo caminho do relatório de totais: a chave
é conferida dentro da rota, e nenhum caminho abaixo dela herda a passagem.
