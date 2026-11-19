---
impacto: nada_mudou
secao: corrigido
titulo: Tela de chaves de integração volta a carregar
---

Cada execução da IA cria uma chave temporária de 5 minutos, e elas nunca eram apagadas. Com
milhares acumuladas, a tela Chaves de integração passava de 18 segundos e mostrava "Não foi
possível carregar as chaves". Agora as temporárias vencidas há mais de um dia são apagadas na
próxima execução da IA da organização.
