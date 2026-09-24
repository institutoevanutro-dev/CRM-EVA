# Financeiro CRM Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill empty CRM contact names from explicitly linked Financeiro patients in the background.

**Architecture:** Extend the existing authenticated Financeiro summary with the linked patient name. A CRM scheduled route scans a bounded set of nameless contacts and updates only still-empty names after validating the linked summary. It never matches on telephone or writes through the Financeiro token.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL, Supabase, Vitest, Docker scheduler.

**Spec:** `docs/superpowers/specs/2026-09-24-nomes-financeiro-crm-design.md`

## Global Constraints

- Only an explicit `crm_customer_links` pair authorizes the name source.
- Preserve existing names, anonymized contacts, `display_name`, and unrelated fields.
- Process at most 40 contacts per run to stay below the 120/min Financeiro rate limit.
- Do not log names, phones, tokens, or CPF.

---

### Task 1: Financeiro read contract

**Files:** Financeiro `db/migrations/0037_crm_customer_name.sql`, `lib/integracoes/crm/servico.ts`, `tests/integration/integracao-crm.test.ts`; CRM `lib/integrations/financeiro/cliente.ts` and its tests.

**Interfaces:** Produce `ResumoCRM`/`ResumoFinanceiro` version 2 with `paciente_nome: string`, only for a linked customer; `consultaFinanceiro(config, contactId)` remains the CRM client entry point.

- [ ] Add a failing Financeiro integration assertion: an explicitly linked patient with zero sales returns `paciente_nome`; wrong organization or unlinked contact returns null.
- [ ] Run `pnpm test:int -- tests/integration/integracao-crm.test.ts` and verify the new assertion fails.
- [ ] Add a migration replacing `crm_customer_summary(uuid,uuid)` to select `customers.name` through `crm_customer_links`, and build JSON with `versao = 2`, `paciente_nome = customer.name`; preserve all existing fields and grants.
- [ ] Update the server return type and CRM Zod schema to version 2 and a trimmed nonempty name up to the patient-name limit.
- [ ] Run Financeiro integration tests and CRM client tests, then commit each repository's changes.

### Task 2: CRM conditional reconciliation

**Files:** CRM `lib/integrations/financeiro/sincronizar-nomes.ts`, `lib/integrations/financeiro/sincronizar-nomes.test.ts`, `supabase/migrations/20260924010000_0276_financeiro_nome_lookup.sql`.

**Interfaces:** `sincronizarNomesFinanceiro(db, config, limit): Promise<{consultados:number;atualizados:number;falhas:number}>`. The database client is the existing Supabase admin client; remote reads use `consultaFinanceiro`.

- [ ] Write failing tests for linked/no-sales success, unlinked, existing name, anonymized contact, shared phone, concurrent name edit, remote failure, and retry.
- [ ] Run `pnpm exec vitest run lib/integrations/financeiro/sincronizar-nomes.test.ts` and verify red.
- [ ] Add `financeiro_name_lookup_at` and query empty-name, non-anonymized contacts for the configured organization ordered by oldest lookup; cap at 40. Stamp attempted lookups and use an `UPDATE` filtered by ID, organization, and still-empty name. Count remote errors without logging identifying fields.
- [ ] Run focused tests and `pnpm typecheck`; commit.

### Task 3: Schedule and audit

**Files:** CRM `app/api/v1/cron/financeiro-nomes/route.ts`, its test, `docker/scheduler/entrypoint.sh`, and audit path used by existing contact updates.

**Interfaces:** `GET /api/v1/cron/financeiro-nomes` accepts the existing internal cron bearer secret, returns aggregate counts, and fails closed without valid secret or Financeiro configuration.

- [ ] Write failing auth and idempotency route tests plus a scheduler registration check.
- [ ] Run focused tests and verify red.
- [ ] Implement the route using the same auth pattern as `storage-redaction`; register a low-frequency scheduler call. Record successful name changes with source `financeiro` through the existing audit mechanism, without putting the value in logs.
- [ ] Run route tests, scheduler tests, typecheck, lint, and relevant unit suite; commit.

### Task 4: Production rollout and verification

**Files:** CRM and Financeiro release artifacts; `integracao-eva/ENTREGA.md`.

**Interfaces:** Deploy Financeiro migration/application first, CRM second, then invoke one bounded sync and verify Cristiano plus unchanged named contacts.

- [ ] Review diffs and run repository release checks.
- [ ] Deploy the Financeiro migration and app, verify version 2 summary through an authenticated route without exposing PII in logs.
- [ ] Deploy CRM, invoke one scheduled cycle, verify the confirmed Cristiano contact displays the patient's name and a named contact remains unchanged.
- [ ] Record commit IDs, tests, deployment status, and any remaining limitations in `ENTREGA.md`.
