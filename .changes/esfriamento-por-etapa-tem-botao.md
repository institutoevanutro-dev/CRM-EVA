---
impacto: capacidade_nova
secao: adicionado
titulo: Cada etapa do funil escolhe em quantas horas o negócio esfria
---

O Radar de risco marcava como "esfriou" quem ficasse **24 horas** sem atividade,
em qualquer etapa e em qualquer negócio. A coluna que permite mudar isso por
etapa (`crm_stages.expected_duration_hours`) existia no banco e era LIDA pelo
radar desde sempre — mas nenhuma tela e nenhuma rota escreviam nela. Era um
botão que nunca tinha sido construído, e na prática todo mundo vivia com 24h.

Agora a tela **Configurações → Etapas do funil** tem, em cada etapa, o campo
"Esfria em (horas)". Quem deixa vazio segue no padrão global, como antes.

Para uma clínica, "sem resposta há 3 horas" já é lead perdido, enquanto numa
negociação de contrato dois dias é normal — e é a etapa que sabe a diferença.

A etapa crítica continua sendo 3× a de esfriamento: pôr 2 horas faz o negócio
esfriar em 2h e virar crítico em 6h.
