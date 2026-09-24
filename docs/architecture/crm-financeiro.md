# Contato e financeiro

```mermaid
flowchart LR
  C[Contato do CRM] -->|API autenticada de dados mínimos| V[Vinculação no financeiro]
  V --> P[Paciente financeiro]
  P --> F[Propostas, vendas e recebimentos]
  F -->|Resumo HTTPS somente leitura| A[Aba Financeiro do contato]
  A -->|Abrir no financeiro| P
```

Contrato, configuração e recuperação: [guia](../integrations/financeiro.md).
