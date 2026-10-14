---
impacto: nada_mudou
secao: corrigido
titulo: A IA volta a marcar atendimento presencial em clínica com unidades, e o passo da grade pode ser mudado pela API
---

Em quem cadastrou unidades e tipos de atendimento que exigem sala, a IA não conseguia marcar: o horário livre chegava sem unidade, a marcação era recusada por falta dela, e a conversa terminava com um caso "confirmar unidade" ou com a IA dizendo ao paciente que tinha marcado sem ter marcado. Agora cada horário livre sai com a unidade da janela da jornada que o gerou, e a IA a recebe junto com o nome da unidade. Se a IA marcar sem dizer a unidade, o CRM usa a da jornada daquele horário; se o mesmo horário existir em duas unidades, nada é marcado e a IA recebe a lista para perguntar ao paciente onde ele prefere.

A consulta de horários livres com uma unidade escolhida passa a mostrar só os horários daquela unidade. Antes ela ignorava a escolha e mostrava os de todas.

Duas janelas encostadas de unidades diferentes no mesmo dia deixam de ser tratadas como um bloco só: cada uma começa a própria grade no próprio horário de início.

O passo da grade de cada tipo de atendimento (de quanto em quanto tempo os horários são oferecidos) agora aparece na lista de tipos da API e pode ser mudado por ela, de 5 a 1440 minutos. Vazio volta ao padrão, que é a duração do atendimento.

Quem não usa unidades nas janelas da jornada não vê diferença nenhuma. Você não precisa fazer nada.
