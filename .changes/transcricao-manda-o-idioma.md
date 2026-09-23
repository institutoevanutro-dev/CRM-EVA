---
impacto: nada_mudou
secao: corrigido
titulo: Áudio do cliente é transcrito no idioma da organização
---

O pedido de transcrição passa a levar o idioma de `organizations.locale`. Sem ele
o provedor adivinhava, e em áudio curto errava: "testando 123 testando" voltava
como "3102 reis 3101".
