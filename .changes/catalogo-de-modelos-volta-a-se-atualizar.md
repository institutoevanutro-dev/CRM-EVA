---
impacto: nada_mudou
secao: corrigido
titulo: A atualização diária da lista e dos preços dos modelos de IA voltou a rodar
---

Todo dia, de madrugada, o sistema deveria buscar a lista atualizada de modelos de inteligência
artificial disponíveis pela OpenRouter, com os preços de cada um. Essa tarefa era recusada pelo
próprio sistema e não fazia nada: o instalador cria dois segredos diferentes para as tarefas
agendadas, e só essa tarefa aceitava um deles, enquanto o agendador manda o outro. Como a
resposta dessas chamadas não era guardada, a recusa não aparecia em lugar nenhum.

Agora ela aceita os mesmos segredos que as demais tarefas. Você não precisa fazer nada: nenhuma
configuração muda e nenhum segredo precisa ser trocado.
