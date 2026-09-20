# Recursos e Durações da Agenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reservar profissional, unidade e sala sem conflito, usando a duração do Catálogo de Produtos e grade de cinco minutos.

**Architecture:** Acrescentar unidades, salas e capacidade paralela como recursos genéricos da agenda. O tipo de agendamento referencia um produto do catálogo e copia a duração vigente para `ends_at`; a disponibilidade semanal existente ganha unidade por janela. Uma função transacional com advisory locks valida profissional e sala antes de gravar.

**Tech Stack:** PostgreSQL/Supabase, TypeScript 6, Zod 4, Next.js 16, Vitest 4, Playwright 1.

**Spec:** `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

## Global Constraints

- Grade de cinco minutos.
- Intramuscular: 7 minutos totais; intravenosa: 30 minutos totais.
- Vitória: três consultórios e duas salas de aplicação.
- Serra: uma sala de atendimento e uma sala de aplicação.
- Somente Vitória permite uma intravenosa e uma intramuscular simultâneas com Isadora.
- Serra não permite aplicações simultâneas.
- Demais durações vêm do Catálogo de Produtos.
- Serviço sem duração não é oferecido automaticamente pela IA.
- O CRM continua sendo a fonte da verdade.

---

### Task 1: Modelar unidades, salas e vínculo com o catálogo

**Files:**
- Create: `supabase/migrations/20260919150000_0270_recursos_fisicos_da_agenda.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Modify: `lib/database.types.ts`
- Test: `tests/invariants/agenda-recursos-fisicos.test.ts`
- Test: `tests/invariants/agenda-rls.test.ts`

**Interfaces:**
- Produces: `calendar_units(id, organization_id, name, timezone, active)`.
- Produces: `calendar_rooms(id, organization_id, unit_id, name, kind, active)` com `kind in ('consultation','application')`.
- Produces: `catalog_products.appointment_duration_minutes integer null`.
- Produces: `calendar_event_types.catalog_product_id`, `required_room_kind` e `concurrency_key`.
- Produces: `calendar_appointments.unit_id`, `room_id`, `duration_minutes_snapshot`.

- [ ] **Step 1: Escrever o invariante de schema e RLS**

```ts
expect(tableExists("calendar_units")).toBe(true);
expect(tableExists("calendar_rooms")).toBe(true);
expect(columnExists("catalog_products", "appointment_duration_minutes")).toBe(true);
expect(columnExists("calendar_appointments", "room_id")).toBe(true);
expect(columnExists("calendar_appointments", "duration_minutes_snapshot")).toBe(true);
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/invariants/agenda-recursos-fisicos.test.ts tests/invariants/agenda-rls.test.ts`

Expected: FAIL por tabelas e colunas ausentes.

- [ ] **Step 3: Criar as tabelas e constraints**

```sql
create table if not exists public.calendar_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  timezone text not null default 'America/Sao_Paulo',
  active boolean not null default true,
  unique (organization_id, name)
);

create table if not exists public.calendar_rooms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  unit_id uuid not null references public.calendar_units(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('consultation','application')),
  active boolean not null default true,
  unique (organization_id, unit_id, name)
);
```

Adicionar as colunas descritas nas interfaces com FKs `on delete set null` onde o histórico precisa sobreviver. `duration_minutes_snapshot` deve ser preenchida a partir de `ends_at - starts_at` no backfill antes de ganhar `not null` e CHECK entre 5 e 1440.

- [ ] **Step 4: Criar RLS e índices**

Leitura por membro ativo; escrita por `manager+`. Criar índices `(organization_id, unit_id, active)` para salas e `(organization_id, room_id, starts_at)` para compromissos.

- [ ] **Step 5: Atualizar baseline, manifesto e tipos gerados**

Run: `pnpm exec supabase gen types typescript --local > lib/database.types.ts`

Expected: `lib/database.types.ts` inclui todas as novas relações.

- [ ] **Step 6: Rodar os testes**

Run: `pnpm vitest run tests/invariants/agenda-recursos-fisicos.test.ts tests/invariants/agenda-rls.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260919150000_0270_recursos_fisicos_da_agenda.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/database.types.ts tests/invariants/agenda-recursos-fisicos.test.ts tests/invariants/agenda-rls.test.ts
git commit -m "feat(agenda): modela unidades e salas"
```

### Task 2: Usar duração do catálogo e unidade na jornada

**Files:**
- Modify: `lib/schemas/routing.ts`
- Modify: `app/app/team/_components/AttendantsClient.tsx`
- Modify: `app/api/v1/attendants/availability/[user_id]/route.ts`
- Modify: `lib/agenda/consulta.ts`
- Modify: `app/api/v1/agenda/tipos/route.ts`
- Modify: `app/app/settings/tenant/agenda/_client.tsx`
- Test: `tests/unit/fuso-horario.test.ts`
- Test: `tests/unit/agenda-catalogo-e-unidade.test.ts`

**Interfaces:**
- Produces: janela `{ dow, start, end, unit_id?: string }`.
- Produces: `resolverDuracaoDoTipo(tipo, produto): number | null`.
- Produces: horários livres com `unit_id` e `duration_minutes`.

- [ ] **Step 1: Escrever testes de duração e jornada**

```ts
expect(resolverDuracaoDoTipo({ duration_minutes: 60 }, { appointment_duration_minutes: 30 })).toBe(30);
expect(resolverDuracaoDoTipo({ duration_minutes: 60 }, { appointment_duration_minutes: null })).toBeNull();
expect(janelaSchema.parse({ dow: 1, start: "09:00", end: "12:00", unit_id: UNIT })).toBeTruthy();
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-catalogo-e-unidade.test.ts tests/unit/fuso-horario.test.ts`

Expected: FAIL porque o catálogo e a jornada não carregam os novos campos.

- [ ] **Step 3: Implementar a resolução única de duração**

```ts
export function resolverDuracaoDoTipo(
  tipo: { catalog_product_id: string | null; duration_minutes: number },
  produto: { appointment_duration_minutes: number | null } | null,
): number | null {
  if (!tipo.catalog_product_id) return tipo.duration_minutes;
  return produto?.appointment_duration_minutes ?? null;
}
```

Se retornar `null`, a consulta de horários devolve `servico_sem_duracao` e não cria slots.

- [ ] **Step 4: Acrescentar unidade às janelas e à tela**

O editor de jornada deve exigir uma unidade para atendimento presencial e permitir unidade vazia em teleconsulta. A API valida que a unidade pertence à organização.

- [ ] **Step 5: Rodar os testes focados**

Run: `pnpm vitest run tests/unit/agenda-catalogo-e-unidade.test.ts tests/unit/fuso-horario.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/schemas/routing.ts app/app/team/_components/AttendantsClient.tsx app/api/v1/attendants/availability lib/agenda/consulta.ts app/api/v1/agenda/tipos app/app/settings/tenant/agenda tests/unit
git commit -m "feat(agenda): usa duracao e unidade do servico"
```

### Task 3: Impedir conflitos de profissional e sala

**Files:**
- Create: `lib/agenda/recursos.ts`
- Modify: `app/api/v1/agenda/agendamentos/_handler.ts`
- Modify: `lib/agenda/consulta.ts`
- Modify: `lib/api/errors.ts`
- Test: `tests/unit/agenda-conflito-de-recursos.test.ts`
- Test: `tests/invariants/agenda-concorrencia-de-sala.test.ts`

**Interfaces:**
- Produces: `selecionarSalaCompativel(args): Promise<SalaSelecionada | RecusaDeRecurso>`.
- Produces: `validarCapacidadeDoProfissional(args): Promise<void>`.
- Produces: erros `agenda_sem_sala_compativel`, `agenda_sala_ocupada`, `agenda_capacidade_excedida`.

- [ ] **Step 1: Escrever os casos de conflito**

Cobrir: mesma sala com horários sobrepostos; profissional normal em dois atendimentos; Isadora em Vitória com IV+IM; Isadora com IV+IV; qualquer simultaneidade na Serra.

```ts
expect(podeCombinar({ unit: "vitoria", existing: ["iv"], incoming: "im", capacity: 2 })).toBe(true);
expect(podeCombinar({ unit: "vitoria", existing: ["iv"], incoming: "iv", capacity: 2 })).toBe(false);
expect(podeCombinar({ unit: "serra", existing: ["iv"], incoming: "im", capacity: 1 })).toBe(false);
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run tests/unit/agenda-conflito-de-recursos.test.ts tests/invariants/agenda-concorrencia-de-sala.test.ts`

Expected: FAIL porque só o dono e o instante inicial são protegidos hoje.

- [ ] **Step 3: Implementar seleção e validação transacionais**

Usar `pg_advisory_xact_lock` com chaves determinísticas de organização+profissional e organização+sala. Dentro da mesma transação, verificar sobreposição por `starts_at < novo_fim and ends_at > novo_inicio` nos estados `pending` e `confirmed`; escolher a primeira sala ativa, compatível e livre em ordem estável.

- [ ] **Step 4: Capturar concorrência sem confirmar em falso**

Dois pedidos simultâneos para a última sala devem produzir um sucesso e um `409 agenda_sala_ocupada`. O segundo nunca cria linha parcialmente preenchida.

- [ ] **Step 5: Rodar testes de unidade e banco**

Run: `pnpm vitest run tests/unit/agenda-conflito-de-recursos.test.ts`

Run: `pnpm vitest run tests/invariants/agenda-concorrencia-de-sala.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/agenda/recursos.ts app/api/v1/agenda/agendamentos/_handler.ts lib/agenda/consulta.ts lib/api/errors.ts tests/unit/agenda-conflito-de-recursos.test.ts tests/invariants/agenda-concorrencia-de-sala.test.ts
git commit -m "feat(agenda): impede conflito de profissional e sala"
```

### Task 4: Criar a configuração visual de recursos

**Files:**
- Create: `app/api/v1/agenda/unidades/route.ts`
- Create: `app/api/v1/agenda/salas/route.ts`
- Create: `app/app/settings/tenant/agenda/_resources.tsx`
- Modify: `app/app/settings/tenant/agenda/_client.tsx`
- Modify: `app/app/settings/tenant/agenda/page.tsx`
- Modify: `app/app/agenda/_client.tsx`
- Test: `tests/e2e/agenda-recursos-fisicos.spec.ts`

**Interfaces:**
- Produces: CRUD de unidades e salas para `manager+`.
- Produces: seletor de unidade/sala e visualização do recurso reservado.

- [ ] **Step 1: Escrever o E2E da configuração e reserva**

O teste cria duas unidades, cria salas, liga um serviço ao tipo de sala, marca um horário e confirma que a agenda exibe profissional, unidade e sala.

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm playwright test tests/e2e/agenda-recursos-fisicos.spec.ts`

Expected: FAIL porque as rotas e a tela ainda não existem.

- [ ] **Step 3: Implementar rotas com Zod, `requireRole("manager")`, RLS e audit**

Cada mutação valida que unidade, sala e tipo pertencem à organização ativa. Responder com `ok()`/`fail()` e registrar criação, alteração e desativação.

- [ ] **Step 4: Implementar a tela e o estado vazio acionável**

Quando não houver sala compatível, mostrar “Cadastre uma sala de aplicação” com link direto ao editor. Ao marcar, mostrar a sala automática e permitir troca manual apenas para papéis autorizados.

- [ ] **Step 5: Rodar E2E e inspeção visual**

Run: `pnpm playwright test tests/e2e/agenda-recursos-fisicos.spec.ts`

Expected: PASS com screenshot da configuração e do compromisso.

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/agenda/unidades app/api/v1/agenda/salas app/app/settings/tenant/agenda app/app/agenda tests/e2e/agenda-recursos-fisicos.spec.ts
git commit -m "feat(agenda): configura unidades e salas"
```

### Task 5: Validar e preparar configuração do Instituto Eva

**Files:**
- Create: `.changes/agenda-recursos-fisicos.md`
- Create: `docs/runbooks/configurar-recursos-da-agenda.md`

- [ ] **Step 1: Documentar a configuração sem hardcode**

O runbook deve mandar cadastrar pela tela:

```text
Vitória: Consultório 1, Consultório 2, Consultório 3, Aplicação 1, Aplicação 2
Serra: Sala de atendimento, Sala de aplicação
Grade: 5 minutos
Intramuscular: 7 minutos
Intravenosa: 30 minutos

Dr. André: segunda e quinta na Serra; terça, quarta e sexta em Vitória
Dra. Ana: quarta à tarde em Vitória
Juliana: segunda à tarde em Vitória
Leonardo: quarta e sexta à tarde em Vitória
Paulo: terça e quinta à tarde em Vitória
Isadora: segunda e quinta o dia todo na Serra; terça, quarta e sexta em Vitória

Expediente das duas unidades: segunda a sexta, 09h–12h e 14h–19h
```

- [ ] **Step 2: Rodar todos os gates aplicáveis**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:db && pnpm build`

Expected: exit code 0 em todos.

- [ ] **Step 3: Sabotar a verificação de sala**

Remover temporariamente o predicado de sobreposição da sala, rodar `agenda-concorrencia-de-sala.test.ts` e confirmar vermelho. Restaurar e confirmar verde.

- [ ] **Step 4: Commit**

```bash
git add .changes/agenda-recursos-fisicos.md docs/runbooks/configurar-recursos-da-agenda.md
git commit -m "docs(agenda): explica configuracao das salas"
```
