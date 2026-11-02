---
impacto: nada_mudou
secao: corrigido
titulo: Tela de chaves avisa quando falta o Operador de agenda
---

Os escopos `agenda:reschedule` (remarcar) e `agenda:outcome` (marcar como realizado) só
funcionam com o papel `role:ai_operator`. Sem ele, a chave era criada normalmente e cada
chamada voltava "Role 'agent' insufficient". Agora a tela de criação de chave mostra um aviso
assim que um desses escopos é marcado sem o Operador de agenda, e o aviso some quando ele é
marcado. A chave continua podendo ser criada; o aviso só evita o tropeço.
