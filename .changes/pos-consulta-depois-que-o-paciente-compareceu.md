---
impacto: capacidade_nova
secao: adicionado
titulo: Fluxo de acompanhamento pós-consulta, que começa quando a equipe marca que o paciente compareceu
---

Até aqui só a falta confirmada pela equipe iniciava um fluxo de mensagens. Agora
o editor de follow-up tem o gatilho «Depois que o paciente compareceu»: quando a
equipe marca o compromisso como «compareceu» (pela Agenda ou pela ferramenta da
IA), o paciente entra no fluxo publicado e armado em um assistente, preso àquela
consulta. Dá para limitar a tipos de compromisso, como no gatilho de falta.

A espera de tempo fixo ganhou «Contar a partir de: Da data da consulta». Toda
espera com essa opção conta da mesma data. Para mandar mensagem 7, 15, 30 e 45
dias depois da consulta, use quatro esperas de 7, 15, 30 e 45 dias, sem calcular
a diferença entre elas.

O paciente que já tem outro acompanhamento ativo não entra, e a Central de avisos
mostra «O acompanhamento pós-consulta não foi iniciado». Se a equipe desfizer a
presença (por exemplo, trocando para falta), o acompanhamento daquela consulta é
cancelado. Quem não configurar o gatilho não vê diferença nenhuma: marcar presença
sem fluxo armado não gera aviso.
