---
impacto: nada_mudou
secao: corrigido
titulo: Funil com algumas centenas de negócios volta a abrir
---

O quadro de um funil com cerca de 400 negócios ou mais parava de carregar. O servidor buscava os dados dos cards (score, próxima ação, contato, conversa) passando todos os ids numa consulta só, e a resposta do banco trazia um cabeçalho maior que o limite do Node — a busca falhava como "fetch failed" e o quadro não abria. Agora essas consultas saem em lotes de 100 ids, e o tamanho do funil não derruba mais o quadro.
