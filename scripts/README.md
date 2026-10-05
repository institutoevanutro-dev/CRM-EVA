# scripts/

CLI utilities pra operação local e de produção.

## Lista

- `seed-tenant.ts` — Cria um tenant manualmente (modo BPO). Placeholder; implementação na Spec 01.
- `importar-clinicas.ts` — importa as clínicas da planilha da agência (empresa, funil, perguntas frequentes, agente em rascunho, atendentes). Só mostra o plano sem `--aplicar`; exige `--destino`. Modelo: `--gerar-modelo <arquivo.xlsx>`.

## Convenções

- Todos em TypeScript (executar via `npx tsx scripts/<nome>.ts`)
- Sempre validar input com Zod
- Logar via `console.error` (stderr) pra mensagens operacionais; `console.log` (stdout) só pra output estruturado consumível por pipe
- Operações destrutivas exigem flag `--confirm` ou prompt interativo
- Toda mutação relevante gera entrada em `api_audit_log` com `actor=script:<nome>`
