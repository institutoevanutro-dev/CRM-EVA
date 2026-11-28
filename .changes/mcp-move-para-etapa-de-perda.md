---
impacto: nada_mudou
secao: corrigido
titulo: Integrações conseguem mover um negócio para a etapa de perda
---

A ferramenta MCP `crm_move_lead_stage` não aceitava o motivo da perda, que o CRM exige
para etapas de perda. Por isso nenhuma integração conseguia levar um card para "Não comprou".
Agora ela aceita `lost_reason` (código do vocabulário do funil, ex.: `other`).
