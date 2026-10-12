# scripts/

CLI utilities pra operação local e de produção.

## Lista

- `seed-tenant.ts` — Cria um tenant manualmente (modo BPO). Placeholder; implementação na Spec 01.
- `importar-clinicas.ts` — importa as clínicas da planilha da agência (empresa, funil, perguntas frequentes, agente em rascunho, atendentes). Só mostra o plano sem `--aplicar`; exige `--destino`. Modelo: `--gerar-modelo <arquivo.xlsx>`.

  **Primeiro acesso do atendente** (provado pela tela em instalação fresca, 2026-10-05): a conta nasce **sem senha**. O e-mail do convite sai pelo Resend; sem `RESEND_API_KEY` o importador avisa "o e-mail não saiu", e o dono copia o link em Equipe › Convites › **Copiar link** e o manda à atendente. Ela abre o link e clica em "Ainda não tenho conta". A tela responde "Você já tem uma conta com este e-mail" e mostra **Entrar e aceitar o convite**. Ela segue para **Esqueci minha senha**. O e-mail de redefinição sai pelo Auth do Supabase, não pelo Resend. Ela define a nova senha, entra e cai direto na clínica (Início e o funil "Agendamentos"). Não precisa clicar em "Aceitar convite", porque o acesso já foi gravado pelo importador.

- `importar-agenda-historica.ts` — importa JSON privado de agendamentos passados com contatos conferidos. `--destino <host>` obrigatório; só prévia por padrão; `--aplicar <sha256-da-prévia>` aplica o arquivo inteiro em uma transação. Ver `docs/runbooks/agenda-historica.md`.

- `jev-teste-de-frases.ts` — manda ao Jev 80 frases escritas à mão (`lib/jev-frases-de-clinica.ts`, sem dado de paciente) pelo mesmo cliente, perguntas, limpeza e cortes do worker de clima, e imprime o placar por tarefa. Não toca no banco. Exige `JEV_API_KEY` no ambiente (sem ela, sai com código 2). Na VPS roda no contêiner do **worker**, que é o que tem `tsx` e `scripts/`: `docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env exec worker pnpm exec tsx scripts/jev-teste-de-frases.ts`.

## Convenções

- Todos em TypeScript (executar via `npx tsx scripts/<nome>.ts`)
- Sempre validar input com Zod
- Logar via `console.error` (stderr) pra mensagens operacionais; `console.log` (stdout) só pra output estruturado consumível por pipe
- Operações destrutivas exigem flag `--confirm` ou prompt interativo
- Toda mutação relevante gera entrada em `api_audit_log` com `actor=script:<nome>`
