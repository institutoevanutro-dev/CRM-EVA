# scripts/

CLI utilities pra operação local e de produção.

## Lista

- `seed-tenant.ts` — Cria um tenant manualmente (modo BPO). Placeholder; implementação na Spec 01.
- `importar-clinicas.ts` — importa as clínicas da planilha da agência (empresa, funil, perguntas frequentes, agente em rascunho, atendentes). Só mostra o plano sem `--aplicar`; exige `--destino`. Modelo: `--gerar-modelo <arquivo.xlsx>`.

  **Primeiro acesso do atendente** (provado pela tela em instalação fresca, 2026-10-05): a conta nasce **sem senha**. O e-mail do convite sai pelo Resend; sem `RESEND_API_KEY` o importador avisa "o e-mail não saiu", e o dono copia o link em Equipe › Convites › **Copiar link** e o manda à atendente. Ela abre o link e clica em "Ainda não tenho conta". A tela responde "Você já tem uma conta com este e-mail" e mostra **Entrar e aceitar o convite**. Ela segue para **Esqueci minha senha**. O e-mail de redefinição sai pelo Auth do Supabase, não pelo Resend. Ela define a nova senha, entra e cai direto na clínica (Início e o funil "Agendamentos"). Não precisa clicar em "Aceitar convite", porque o acesso já foi gravado pelo importador.

## Convenções

- Todos em TypeScript (executar via `npx tsx scripts/<nome>.ts`)
- Sempre validar input com Zod
- Logar via `console.error` (stderr) pra mensagens operacionais; `console.log` (stdout) só pra output estruturado consumível por pipe
- Operações destrutivas exigem flag `--confirm` ou prompt interativo
- Toda mutação relevante gera entrada em `api_audit_log` com `actor=script:<nome>`
