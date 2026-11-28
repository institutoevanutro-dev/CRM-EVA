---
impacto: capacidade_nova
secao: adicionado
titulo: Chave de integração que só marca as datas do tratamento
---

Em Configurações › Chaves de API há um escopo novo, `agenda:book`. Ele deixa uma integração
(o Prontuário) marcar compromissos e ler os tipos de atendimento e a equipe, e nada além disso.
Ele também exige o Operador de agenda. Até agora, marcar pela integração pedia `mcp:write`, que
libera todas as escritas. Uma chave que já existe não muda.

O compromisso marcado por uma chave de integração aparece como "do sistema", não da IA, e fica sem "quem converteu".
Ele também não dispara a conversão "Agendou" para Meta e Google: o paciente já converteu antes, na consulta em que
fechou o tratamento.
