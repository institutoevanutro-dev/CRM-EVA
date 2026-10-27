---
impacto: nada_mudou
secao: corrigido
titulo: O custo do turno do agente de IA é registrado fracionado, não 1 centavo por chamada
---

Cada execução do agente arredondava o custo para cima, para o centavo inteiro. Numa
chamada barata (frações de centavo) isso registrava até 12× o custo real, inflava o
painel de custo e podia cortar o turno cedo pelo teto de gasto por chamada. Agora o
custo é gravado como é.

Portado do projeto original (DeskcommCRM, PR #3394 de @jmpo).
