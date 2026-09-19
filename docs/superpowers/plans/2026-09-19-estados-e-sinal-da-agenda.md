# Estados e Sinal da Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar Reserva, Aguardando sinal, Confirmado, Em atendimento, Concluído, Cancelado, Faltou e Remarcado sem afirmar pagamento recebido automaticamente.

**Architecture:** Manter o estado operacional do compromisso separado do estado do sinal. “Remarcado” é uma transição auditável, não um estado terminal; o compromisso continua ativo no novo horário. O status visível é derivado de `calendar_appointments.status`, `signal_status` e da timeline.

**Tech Stack:** PostgreSQL/Supabase, Next.js 16, TypeScript 6, Vitest 4, Playwright 1.

**Spec:** `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

## Global Constraints

- Somente consultas médicas configuradas com `requires_signal=true` entram no fluxo de sinal.
- O sistema nunca afirma que o pagamento foi recebido sem confirmação humana.
- Silêncio do paciente não cancela nem libera horário.
- O comprovante enviado interrompe cobranças automáticas e cria conferência humana.
- Cancelamento e remarcação preservam histórico e autoria.
- “Remarcado” aparece na timeline, enquanto o compromisso segue no novo estado atual.

---

### Task 1: Separar situação do compromisso e situação do sinal

**Files:**
- Create: `supabase/migrations/20260919170000_0272_estado_do_sinal_na_agenda.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Modify: `lib/agenda/tipos.ts`
- Modify: `lib/database.types.ts`
- Test: `tests/invariants/agenda-vocabulario.test.ts`
- Test: `tests/unit/agenda-estado-visivel.test.ts`

**Interfaces:**
- Produces: `signal_status in ('not_required','awaiting','proof_sent','confirmed','human_review')`.
- Produces: situação operacional adicional `in_service`.
- Produces: `estadoVisivelDoAgendamento(appointment): EstadoVisivel`.

- [ ] **Step 1: Escrever testes exaustivos do estado visível**

```ts
expect(estadoVisivelDoAgendamento({ status: "pending", signal_status: "not_required" })).toBe("reserved");
expect(estadoVisivelDoAgendamento({ status: "pending", signal_status: "awaiting" })).toBe("awaiting_signal");
expect(estadoVisivelDoAgendamento({ status: "confirmed", signal_status: "confirmed" })).toBe("confirmed");
expect(estadoVisivelDoAgendamento({ status: "in_service", signal_status: "confirmed" })).toBe("in_service");
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-estado-visivel.test.ts tests/invariants/agenda-vocabulario.test.ts`

Expected: FAIL porque `signal_status` e `in_service` ainda não existem.

- [ ] **Step 3: Criar migration e backfill seguros**

Adicionar `signal_status` com default `not_required`. Para compromissos vivos cujo tipo tem `requires_signal=true`, preencher `awaiting`; não inferir pagamento confirmado de mensagem ou comprovante. Acrescentar `in_service` ao CHECK do status e decidir explicitamente que ele ocupa horário e segura o lead.

- [ ] **Step 4: Implementar o estado visível derivado**

```ts
export type EstadoVisivel =
  | "reserved" | "awaiting_signal" | "confirmed" | "in_service"
  | "completed" | "cancelled" | "no_show";
```

`rescheduled` permanece tipo de atividade da timeline e nunca substitui o estado atual.

- [ ] **Step 5: Atualizar baseline, manifesto e tipos**

Run: `pnpm exec supabase gen types typescript --local > lib/database.types.ts`

- [ ] **Step 6: Rodar testes e commit**

Run: `pnpm vitest run tests/unit/agenda-estado-visivel.test.ts tests/invariants/agenda-vocabulario.test.ts`

```bash
git add supabase/migrations/20260919170000_0272_estado_do_sinal_na_agenda.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/agenda/tipos.ts lib/database.types.ts tests/unit/agenda-estado-visivel.test.ts tests/invariants/agenda-vocabulario.test.ts
git commit -m "feat(agenda): separa estado do sinal"
```

### Task 2: Ligar reservas ao fluxo T+40/T+60 existente

**Files:**
- Modify: `lib/followup/revisao-do-sinal.ts`
- Modify: `app/api/v1/cron/sinal-revisao-humana/route.ts`
- Create: `supabase/migrations/20260919173000_0273_sinal_atualiza_estado_da_reserva.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/sinal-integracao-t40-t60.test.ts`
- Test: `tests/unit/sinal-nao-libera-horario.test.ts`

**Interfaces:**
- Consumes: `calendar_event_types.requires_signal` e `calendar_appointments.signal_status`.
- Produces: transições `awaiting -> proof_sent -> human_review|confirmed`.

- [ ] **Step 1: Escrever casos de bloqueio**

Comprovante enviado deve cancelar próximos lembretes e marcar `proof_sent`; T+60 deve criar revisão humana; silêncio deve manter o compromisso ocupando a agenda.

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/invariants/sinal-integracao-t40-t60.test.ts tests/unit/sinal-nao-libera-horario.test.ts`

Expected: FAIL porque o fluxo atual não grava o estado visível no compromisso.

- [ ] **Step 3: Atualizar as funções sem editar a política financeira**

A revisão humana confirma ou recusa o comprovante. Somente a confirmação humana escreve `signal_status='confirmed'` e pode promover a reserva a `status='confirmed'`. Nenhum cron cancela o compromisso.

- [ ] **Step 4: Rodar testes e commit**

Run: `pnpm vitest run tests/invariants/sinal-integracao-t40-t60.test.ts tests/unit/sinal-nao-libera-horario.test.ts`

```bash
git add lib/followup/revisao-do-sinal.ts app/api/v1/cron/sinal-revisao-humana supabase/migrations/20260919173000_0273_sinal_atualiza_estado_da_reserva.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/sinal-integracao-t40-t60.test.ts tests/unit/sinal-nao-libera-horario.test.ts
git commit -m "feat(agenda): mostra andamento do sinal"
```

### Task 3: Mostrar estados e timeline na Agenda

**Files:**
- Modify: `components/agenda/tipos.ts`
- Modify: `components/agenda/HistoricoDaAgenda.tsx`
- Modify: `app/app/agenda/_client.tsx`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Test: `tests/unit/agenda-separar-historico.test.tsx`
- Test: `tests/e2e/agenda-remarcar-e-cancelar.spec.ts`

**Interfaces:**
- Produces: chips em português para os sete estados atuais.
- Produces: evento de timeline “Remarcado” com horário anterior, horário novo, autor, data e motivo.

- [ ] **Step 1: Escrever teste visual**

```tsx
expect(screen.getByText("Aguardando sinal")).toBeTruthy();
expect(screen.getByText("Em atendimento")).toBeTruthy();
expect(screen.getByText("Remarcado")).toBeTruthy();
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-separar-historico.test.tsx`

Expected: FAIL nos rótulos e no histórico da remarcação.

- [ ] **Step 3: Renderizar estado atual e histórico separadamente**

O cartão mostra um único estado atual. A timeline mostra todas as transições, inclusive remarcações, sem apagar o horário anterior.

- [ ] **Step 4: Rodar unitário e E2E**

Run: `pnpm vitest run tests/unit/agenda-separar-historico.test.tsx`

Run: `pnpm playwright test tests/e2e/agenda-remarcar-e-cancelar.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/agenda app/app/agenda app/api/v1/agenda/agendamentos tests/unit/agenda-separar-historico.test.tsx tests/e2e/agenda-remarcar-e-cancelar.spec.ts
git commit -m "feat(agenda): mostra sinal e historico da remarcacao"
```

### Task 4: Validar o ciclo completo

**Files:**
- Create: `.changes/estados-e-sinal-da-agenda.md`

- [ ] **Step 1: Rodar os gates completos**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:db && pnpm build`

Expected: exit code 0 em todos.

- [ ] **Step 2: Sabotar o bloqueio por silêncio**

Alterar temporariamente o teste para simular um cron cancelando a reserva em T+60 e confirmar que `sinal-nao-libera-horario.test.ts` fica vermelho. Restaurar o comportamento e repetir verde.

- [ ] **Step 3: Criar fragmento de release**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Agenda mostra reserva, sinal e andamento do atendimento
---
A equipe acompanha reserva, sinal, confirmação, atendimento, conclusão, falta, cancelamento e remarcações sem perder o histórico do paciente.
```

- [ ] **Step 4: Commit**

```bash
git add .changes/estados-e-sinal-da-agenda.md
git commit -m "docs(agenda): registra estados e sinal"
```
