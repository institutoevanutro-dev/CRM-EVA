# Reiniciar teste (zerar o estado de IA de um contato de teste) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um gestor clica "Reiniciar teste" na página de um contato que está na lista de números de teste do canal, e a próxima mensagem desse número é tratada pelo agente de IA como conversa nova (abertura, roteiro do começo, sem memória), sem apagar mensagens, card nem agendamentos.

**Architecture:** O histórico que o agente lê já tem fronteira por atendimento (`conversations.service_revision`, migration 0222): fechar a conversa por `fn_service_status(..., 'closed')` corta o histórico e o checkpoint sem apagar mensagem. O que sobra é resíduo por CONTATO, que a função nova limpa numa transação: `fn_reiniciar_teste_do_contato(p_org, p_contact)` (security definer, só service_role). A rota `POST /api/v1/contacts/[id]/reiniciar-teste` (manager+) confere que o telefone do contato é número de teste de algum canal da organização antes de chamar a função.

**Tech Stack:** Postgres (plpgsql), Next.js Route Handler, React, Vitest, invariantes `pnpm test:db`.

**Spec:** este plano (decisão do André em 10/10/2026: "Pode fazer o botão"; só números da lista de teste, nunca paciente real).

## Global Constraints

- Migration **0351** (reservada): `supabase/migrations/20261010160000_0351_reiniciar_teste_do_contato.sql` + apêndice idempotente no `supabase/baseline.sql` ANTES do bloco `-- ---- VARREDURA anon ...` + linha no `MANIFEST.md`. `create or replace function`; `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;`.
- NÃO apaga nem altera: `messages`, `crm_leads` (card e etapa), `calendar_appointments`, `api_audit_log`, `llm_calls`, `ai_agent_runs`, `before_send_traces`, `outbound_copies`, `pacing_ledger`, memória da organização.
- A função, na ordem: `perform fn_service_lock(p_org, p_contact)`; recusa (`raise exception ... using errcode = 'P0001'`, mensagem `contato_nao_e_de_teste`) se o telefone do contato não casar com nenhum `channel_sessions.metadata->'ai_test_phone_numbers'` da organização em canal com `metadata->>'ai_gate_mode' = 'pre_go_live'` (comparação pelos últimos 8 dígitos + mesmo DDI/DDD, para tolerar o nono dígito); fecha toda conversa não-grupo do contato que não esteja `closed`/`archived` via `fn_service_status(p_org, id, 'closed', null)`; em TODAS as conversas do contato zera `bot_silenced_until`, `last_handoff_at`, `last_handoff_reason`, `snooze_until`; `contacts.force_human = false`; apaga do contato `lead_notes`, `lead_state_transitions`, `lead_state`, `send_ledger`; `cron_jobs.enabled = false` do contato; cancela `followup_enrollments` vivos do contato (status `cancelled`, `cancel_reason = 'Teste reiniciado'`, `completed_at = now()`, `next_eval_at = null`); cancela `agent_cases` abertos (`awaiting_human`/`awaiting_lead`) das conversas do contato; resolve `agent_inbox_items` abertos de kind `handoff` com `ref_kind = 'contact'` e `ref_id = p_contact`. Devolve `jsonb` com as contagens de cada passo.
- Tudo filtrado por `organization_id = p_org` E contato; nada sem os dois filtros.
- Rota: `requireSupportWrite()` → `requireRole("manager")` → `mfaEmDivida()` (como `app/api/v1/contacts/[id]/unblock/route.ts`) → uuid → contato da org (404 se não) → guarda de teste no TypeScript com `lerNumerosDeTeste` + `numeroPodeTestar` (`lib/ai/elegibilidade/pre-go-live.ts`) sobre os canais da org em `pre_go_live` → se não for de teste: 422 `contato_nao_e_de_teste`, mensagem "Só dá para reiniciar o teste de um número que está na lista de teste do canal." → `createAdminClient().rpc("fn_reiniciar_teste_do_contato", ...)` → audit `contact.teste_reiniciado` (novo, no fim de `AUDIT_ACTIONS`) com as contagens → `ok({ ...contagens })`.
- A rota NUNCA devolve a lista de números de teste (só admin pode lê-la).
- UI: na página do contato (`app/app/contacts/[id]/_client.tsx`), para `manager`+, botão "Reiniciar teste" com AlertDialog: título "Reiniciar o teste deste contato?", texto "A próxima mensagem deste número será tratada pela IA como uma conversa nova. As mensagens antigas, o card do funil e os agendamentos continuam no CRM. Só funciona para números que estão na lista de teste do canal." Sucesso: toast "Teste reiniciado. A próxima mensagem começa do zero." Erro 422: mostra a mensagem da API. Strings com entrada em espanhol em `lib/i18n/dicionario.ts`. Sem travessão.
- `lib/database.types.ts`: acrescentar a função em `Functions` à mão, no padrão das vizinhas.

## Review Focus

1. **Paciente real**: contato cujo telefone não está na lista de teste → 422 na rota E exceção na função se chamada direto; nada muda. Testes nas Tasks 1 e 2.
2. **Outra organização**: contato da org B com `p_org` = A → nada é tocado (função e rota). Invariante na Task 1.
3. **Recomeço de verdade**: depois do reset, `get-lead-context` devolve histórico vazio para a próxima mensagem, sem `lead_state`, sem `lead_notes`, e a contagem de envios aceitos (`send_ledger`) é zero (a IA se apresenta de novo). Invariante na Task 1.
4. **Travas de humano**: contato em handoff (`force_human`, `bot_silenced_until`, conversa atribuída) volta a ser atendido pela IA na próxima mensagem. Invariante na Task 1.
5. **Nono dígito**: número de teste gravado com o 9 e contato sem o 9 (e o inverso) casam. Testes nas Tasks 1 e 2.

---

### Task 1: Função SQL, migration e invariantes

**Files:** `supabase/migrations/20261010160000_0351_reiniciar_teste_do_contato.sql`; `supabase/baseline.sql`; `supabase/migrations/MANIFEST.md`; `lib/database.types.ts`; `tests/invariants/reiniciar-teste-do-contato.test.ts`.

- [ ] Invariante primeiro (RED), copiando o seed de `tests/invariants/lgpd-anonimizar-pela-tela-redige-conversas.test.ts` (pool pg, `seedGov`): canal em `pre_go_live` com o telefone do contato na lista; contato com conversa aberta, mensagens inbound e outbound, `lead_state` com etapa avançada, `lead_notes`, `send_ledger` aceito, `force_human = true`, `bot_silenced_until` no futuro, um `cron_jobs` habilitado, um `followup_enrollments` ativo, um `agent_cases` `awaiting_human`, um `agent_inbox_items` handoff aberto, um `crm_leads` e um `calendar_appointments` futuro. Chamar a função como service role e afirmar: conversa `closed` com `service_revision` incrementado; a query de histórico de `lib/agent-engine/edge/crm/get-lead-context.ts` (reproduza o predicado da fronteira) devolve 0 mensagens depois de simular a reabertura por um inbound novo (ou afirme pelo predicado com a revisão nova); `lead_state`, `lead_state_transitions`, `lead_notes`, `send_ledger` do contato = 0 linhas; travas zeradas; cron desabilitado; enrollment `cancelled` com o motivo; caso cancelado; aviso de handoff resolvido; `messages`, `crm_leads` e `calendar_appointments` INTACTOS (mesma contagem); contagens no jsonb batem. Casos de recusa: telefone fora da lista → exceção `contato_nao_e_de_teste` e nada muda; canal em modo `open` (sem pre_go_live) → exceção; contato de outra org → exceção ou zero efeito, nada muda; nono dígito (lista com 9, contato sem 9) → aceita. Grants: `anon` e `authenticated` não executam a função (padrão de `tests/invariants/hardening-definer-varredura.test.ts`).
- [ ] Migration + baseline + MANIFEST + tipos. Confira no baseline os nomes reais de colunas e os valores válidos de status de `agent_cases`, `followup_enrollments`, `agent_inbox_items`, `cron_jobs` antes de escrever; se um CHECK não aceitar um valor do plano, use o valor de cancelamento que a tabela aceita e diga qual.
- [ ] `pnpm test:db` (foreground) exit 0; `pnpm exec vitest run tests/unit/manifest-x-migrations.test.ts tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/baseline-reaplicavel.test.ts tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts`; `pnpm typecheck`. Commit `feat(teste): função que reinicia o estado de IA de um contato de teste (migration 0351)`.

### Task 2: Rota, auditoria e botão

**Files:** `lib/audit/actions.ts` (`contact.teste_reiniciado` no fim); `app/api/v1/contacts/[id]/reiniciar-teste/route.ts` + `route.test.ts`; `hooks/contacts/useReiniciarTeste.ts` (forma de `hooks/contacts/useUnblockContact.ts`); `app/app/contacts/[id]/_client.tsx` (botão + AlertDialog no padrão do desbloqueio, L145-166, visível para manager+); `lib/i18n/dicionario.ts`.

- [ ] Testes da rota (RED): acesso negado (role e suporte) sem tocar no banco; contato de outra org → 404; telefone fora da lista → 422 `contato_nao_e_de_teste` sem chamar a RPC; número de teste (com e sem nono dígito) → RPC chamada com `p_org` da sessão e `p_contact`, audit `contact.teste_reiniciado` com as contagens, 200; erro da RPC → 500 sem audit; a resposta nunca contém a lista de números. Teste de tela (no padrão dos testes vizinhos de `_client`/dialogs, se existirem; senão um teste de componente do diálogo): botão aparece para manager, some para agent; confirmar chama o hook.
- [ ] Implementar. `pnpm typecheck`, `pnpm lint`, focados, `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`, `tests/unit/suporte-cobertura-de-efeitos.test.ts`, `tests/unit/audit-lista-do-painel-e-derivada.test.tsx`. Commit `feat(teste): botão Reiniciar teste na página do contato`.

### Task 3: Fragmento, docs e suítes

- `.changes/reiniciar-teste.md` (formato dos existentes; `capacidade_nova`: "Na página de um contato que está na lista de teste do canal, o gestor pode clicar em Reiniciar teste: a próxima mensagem desse número é tratada pela IA como conversa nova. Mensagens, card e agendamentos não são apagados."), linha no `docs/testing/user-journey-map.md` (não marcada; prova pela tela pendente), nó/aresta no mapa de arquitetura que já tiver o gate de pré go-live ou a página do contato (procure; siga o esquema do arquivo).
- [ ] `pnpm release:conferir`; FULL `pnpm test:unit` e FULL `pnpm test:db` (rodapés e exit). Commit `docs(teste): fragmento e mapa do Reiniciar teste`.
