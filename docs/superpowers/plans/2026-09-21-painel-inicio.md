# Painel Início — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Primeira tela do CRM ("Início") com o que cada pessoa precisa fazer hoje e, para gerente/admin, o que impede o CRM de funcionar.

**Architecture:** Funções puras por bloco em `lib/inicio/` (recebem o cliente Supabase de sessão + contexto, devolvem `Bloco`). Uma rota `GET /api/v1/inicio` roda todas com `Promise.allSettled` — bloco que falha vira `{ ok:false }` sem derrubar os outros. Página client `/app/inicio` com React Query; `homeDaInterface` passa a preferir `/app/inicio`.

**Tech Stack:** Next.js 16 App Router, React 19, TS estrito, Supabase (RLS), Zod, @tanstack/react-query, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-painel-inicio-design.md`

## Global Constraints

- **Sem mudança de schema.** Só leitura de tabelas existentes (nada em `supabase/`).
- Toda query filtra `organization_id = auth.org.orgId` explicitamente, mesmo com RLS (CLAUDE.md › Multi-tenancy).
- Cliente de sessão (`createClient` de `@/lib/supabase/server`), **nunca** admin/service role.
- Gestão só para `manager`/`admin` — decidido **no servidor** (`ROLE_RANK[role] >= ROLE_RANK.manager`).
- Wrappers `ok()`/`fail()` de `@/lib/api/wrappers`; `X-Request-Id` via `requestId`.
- Todo texto de tela em `t()` com entrada `es` em `lib/i18n/dicionario.ts` (guarda: `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).
- Sem `console.log`. Máx. 5 itens por bloco na resposta; `total` é a contagem real.
- "Hoje" = dia no fuso `America/Sao_Paulo` (constante `FUSO_PADRAO`); `user.timezone` vence se presente.
- Bloco "Sistema" mostra só "no ar" + versão; **sem botão de atualizar** (a instalação do fork atualiza por GHCR `:latest`, e o fluxo de update da tela aponta para releases do projeto original).
- Tela nova tem porta em `lib/navigation/catalogo.ts` (DoD 14). Fragmento em `.changes/` (DoD 17).
- `pnpm test:unit` sem caminho, exit code é a autoridade.

## Review Focus

1. **Conversa em grupo ou fechada** não pode aparecer em "esperando resposta" — test em Task 2 (`is_group=true`, `status='closed'`).
2. **Virada do dia no fuso**: agendamento às 23:30 BRT (02:30 UTC do dia seguinte) é "hoje" — test em Task 1.
3. **Colaborador (`agent`) chamando a rota** não recebe nenhum bloco de gestão, nem vazio — test em Task 4.
4. **Um bloco que lança exceção** (tabela ausente num clone antigo) não derruba a tela — test em Task 4.
5. **Orçamento de IA sem linha** (`ai_budgets` vazio num clone) mostra "sem limite configurado", não erro — test em Task 3.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `lib/inicio/tipos.ts` | Tipos `Bloco`, `ItemDoBloco`, `ContextoDoInicio`; `janelaDeHoje()` |
| `lib/inicio/tipos.test.ts` | janela do dia no fuso |
| `lib/inicio/fake-db.test-helper.ts` | dublê que aplica eq/is/in/neq/gte/lt/lte/not-is sobre linhas |
| `lib/inicio/meu-dia.ts` | `avisosAbertos`, `esperandoResposta`, `agendaDeHoje`, `minhasTarefas` |
| `lib/inicio/meu-dia.test.ts` | blocos pessoais |
| `lib/inicio/gestao.ts` | `configuracaoPendente`, `numerosDeHoje`, `gastoDeIa` |
| `lib/inicio/gestao.test.ts` | blocos de gestão |
| `app/api/v1/inicio/route.ts` | orquestra blocos, gate de papel |
| `app/api/v1/inicio/route.test.ts` | papel, degradação por bloco |
| `app/app/inicio/page.tsx` | server page (auth + título) |
| `app/app/inicio/_components/PainelInicio.tsx` | client: blocos, links, estados |
| `lib/navigation/catalogo.ts` | porta `/app/inicio` |
| `lib/navigation/interface.ts` | `homeDaInterface` prefere `/app/inicio` |
| `tests/unit/interface-por-vinculo.test.ts` | nova expectativa de home |
| `lib/i18n/dicionario.ts` | textos em espanhol |
| `tests/e2e/painel-inicio.spec.ts` | prova pela tela |
| `.changes/painel-inicio.md` | fragmento de release |

---

### Task 1: Tipos e janela de "hoje"

**Files:**
- Create: `lib/inicio/tipos.ts`, `lib/inicio/tipos.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FUSO_PADRAO = "America/Sao_Paulo";
  export interface ItemDoBloco { id: string; titulo: string; detalhe?: string; href: string; }
  export type Bloco =
    | { ok: true; total: number; itens: ItemDoBloco[] }
    | { ok: false };
  export interface ContextoDoInicio { orgId: string; userId: string; agora: Date; fuso: string; }
  export function janelaDeHoje(agora: Date, fuso: string): { inicio: string; fim: string; dia: string };
  export const LIMITE_DE_ITENS = 5;
  ```

- [ ] **Step 1: Write the failing test** — `lib/inicio/tipos.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { janelaDeHoje } from "./tipos";

describe("janelaDeHoje", () => {
  it("23:30 em São Paulo ainda é o mesmo dia, embora já seja amanhã em UTC", () => {
    const agora = new Date("2026-09-22T02:30:00Z"); // 21/09 23:30 BRT
    const j = janelaDeHoje(agora, "America/Sao_Paulo");
    expect(j.dia).toBe("2026-09-21");
    expect(j.inicio).toBe("2026-09-21T03:00:00.000Z");
    expect(j.fim).toBe("2026-09-22T03:00:00.000Z");
  });
  it("fuso inválido cai no padrão em vez de lançar", () => {
    const j = janelaDeHoje(new Date("2026-09-21T15:00:00Z"), "Nao/Existe");
    expect(j.dia).toBe("2026-09-21");
  });
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run lib/inicio/tipos.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/inicio/tipos.ts`

```ts
/**
 * PAINEL INÍCIO — o vocabulário comum dos blocos.
 *
 * Cada bloco é uma função pura (cliente de sessão + contexto → `Bloco`). A rota
 * roda todos com `Promise.allSettled`: um bloco que falha vira `{ ok:false }` e
 * a tela mostra "não consegui carregar" SÓ nele. Spec:
 * docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 */
export const FUSO_PADRAO = "America/Sao_Paulo";
export const LIMITE_DE_ITENS = 5;

export interface ItemDoBloco {
  id: string;
  titulo: string;
  detalhe?: string;
  href: string;
}

export type Bloco = { ok: true; total: number; itens: ItemDoBloco[] } | { ok: false };

export interface ContextoDoInicio {
  orgId: string;
  userId: string;
  agora: Date;
  fuso: string;
}

function fusoValido(fuso: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

/** Deslocamento (ms) do fuso em relação ao UTC num instante. */
function deslocamento(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instante);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return comoUtc - instante.getTime();
}

/** [inicio, fim) do dia corrente no fuso, em ISO UTC, e o dia como `YYYY-MM-DD`. */
export function janelaDeHoje(agora: Date, fuso: string) {
  const tz = fusoValido(fuso);
  const local = new Date(agora.getTime() + deslocamento(agora, tz));
  const dia = local.toISOString().slice(0, 10);
  const meiaNoiteComoUtc = Date.parse(`${dia}T00:00:00.000Z`);
  const inicio = new Date(meiaNoiteComoUtc - deslocamento(new Date(meiaNoiteComoUtc), tz));
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio: inicio.toISOString(), fim: fim.toISOString(), dia };
}
```

- [ ] **Step 4: Run** `pnpm exec vitest run lib/inicio/tipos.test.ts` — Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add lib/inicio/tipos.ts lib/inicio/tipos.test.ts
git commit -m "feat(inicio): tipos dos blocos e janela de hoje no fuso"
```

---

### Task 2: Blocos pessoais ("Meu dia")

**Files:**
- Create: `lib/inicio/fake-db.test-helper.ts`, `lib/inicio/meu-dia.ts`, `lib/inicio/meu-dia.test.ts`

**Interfaces:**
- Consumes: `Bloco`, `ContextoDoInicio`, `janelaDeHoje`, `LIMITE_DE_ITENS` (Task 1)
- Produces:
  ```ts
  type Db = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;
  export async function avisosAbertos(db: Db, ctx: ContextoDoInicio): Promise<Bloco>;
  export async function esperandoResposta(db: Db, ctx: ContextoDoInicio): Promise<Bloco>;
  export async function agendaDeHoje(db: Db, ctx: ContextoDoInicio): Promise<Bloco>;
  export async function minhasTarefas(db: Db, ctx: ContextoDoInicio): Promise<Bloco>;
  export function fakeDb(tabelas: Record<string, Array<Record<string, unknown>>>): { db: Db };
  ```

- [ ] **Step 1: Write the fake** — `lib/inicio/fake-db.test-helper.ts`

```ts
/**
 * Dublê que APLICA os filtros sobre linhas em memória (mesma ideia de
 * app/api/v1/agenda/vinculos/route.test.ts): sem isso, tirar o
 * `.eq("organization_id", …)` de um bloco deixaria os testes verdes.
 */
type Linha = Record<string, unknown>;

export function fakeDb(tabelas: Record<string, Linha[]>) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let ordem: { col: string; asc: boolean } | null = null;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), q),
      not: (c: string, op: string, v: unknown) => {
        if (op !== "is") throw new Error(`not.${op} não suportado`);
        filtros.push((l) => (l[c] ?? null) !== v);
        return q;
      },
      gte: (c: string, v: string) => (filtros.push((l) => String(l[c] ?? "") >= v), q),
      lt: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) < v), q),
      lte: (c: string, v: string) => (filtros.push((l) => l[c] != null && String(l[c]) <= v), q),
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limite = n), q),
      then: (resolve: (r: { data: Linha[]; error: null; count: number }) => unknown) => {
        const todas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (ordem) {
          const { col, asc } = ordem;
          todas.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return resolve({ data: todas.slice(0, limite), error: null, count: todas.length });
      },
    };
    return q;
  };
  return { db: { from } as never };
}
```

- [ ] **Step 2: Write the failing test** — `lib/inicio/meu-dia.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fakeDb } from "./fake-db.test-helper";
import { agendaDeHoje, avisosAbertos, esperandoResposta, minhasTarefas } from "./meu-dia";

const ORG = "org-1", OUTRA = "org-2", EU = "user-1", OUTRO = "user-2";
const ctx = { orgId: ORG, userId: EU, agora: new Date("2026-09-21T15:00:00Z"), fuso: "America/Sao_Paulo" };
const ok = <T>(b: T) => b as Extract<T, { ok: true }>;

describe("avisosAbertos", () => {
  it("conta só os abertos da organização", async () => {
    const { db } = fakeDb({ agent_inbox_items: [
      { id: "a1", organization_id: ORG, status: "open", title: "Comprovante", created_at: "2026-09-21T10:00:00Z" },
      { id: "a2", organization_id: ORG, status: "resolved", title: "x", created_at: "2026-09-21T10:00:00Z" },
      { id: "a3", organization_id: OUTRA, status: "open", title: "y", created_at: "2026-09-21T10:00:00Z" },
    ] });
    const b = ok(await avisosAbertos(db, ctx));
    expect(b.total).toBe(1);
    expect(b.itens.map((i) => i.id)).toEqual(["a1"]);
    expect(b.itens[0]!.href).toBe("/app/ai/inbox");
  });
});

describe("esperandoResposta", () => {
  const base = { organization_id: ORG, assigned_to_user_id: EU, is_group: false, status: "open",
    last_outbound_at: "2026-09-21T09:00:00Z", last_message_preview: "oi" };
  it("inclui minha conversa cuja última mensagem é do paciente; exclui grupo, fechada, de outra pessoa e já respondida", async () => {
    const { db } = fakeDb({ conversations: [
      { ...base, id: "c1", last_inbound_at: "2026-09-21T10:00:00Z" },
      { ...base, id: "c2", last_inbound_at: "2026-09-21T08:00:00Z" },          // já respondida
      { ...base, id: "c3", last_inbound_at: "2026-09-21T10:00:00Z", is_group: true },
      { ...base, id: "c4", last_inbound_at: "2026-09-21T10:00:00Z", status: "closed" },
      { ...base, id: "c5", last_inbound_at: "2026-09-21T10:00:00Z", assigned_to_user_id: OUTRO },
      { ...base, id: "c6", last_inbound_at: "2026-09-21T10:00:00Z", last_outbound_at: null },
      { ...base, id: "c7", last_inbound_at: "2026-09-21T10:00:00Z", organization_id: OUTRA },
    ] });
    const b = ok(await esperandoResposta(db, ctx));
    expect(b.itens.map((i) => i.id).sort()).toEqual(["c1", "c6"]);
    expect(b.total).toBe(2);
    expect(b.itens[0]!.href).toMatch(/^\/app\/inbox\?conversation=/);
  });
});

describe("agendaDeHoje", () => {
  it("só meus compromissos de hoje no fuso, sem cancelados", async () => {
    const base = { organization_id: ORG, owner_user_id: EU, status: "confirmed", title: "Consulta" };
    const { db } = fakeDb({ calendar_appointments: [
      { ...base, id: "h1", starts_at: "2026-09-21T13:00:00Z" },
      { ...base, id: "h2", starts_at: "2026-09-22T02:30:00Z" },               // 23:30 BRT de hoje
      { ...base, id: "h3", starts_at: "2026-09-22T13:00:00Z" },               // amanhã
      { ...base, id: "h4", starts_at: "2026-09-21T14:00:00Z", status: "cancelled" },
      { ...base, id: "h5", starts_at: "2026-09-21T14:00:00Z", owner_user_id: OUTRO },
    ] });
    const b = ok(await agendaDeHoje(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["h1", "h2"]);
  });
});

describe("minhasTarefas", () => {
  it("vencidas e de hoje, minhas, não concluídas", async () => {
    const base = { organization_id: ORG, assigned_to: EU, status: "pending", title: "Ligar" };
    const { db } = fakeDb({ crm_tasks: [
      { ...base, id: "t1", due_date: "2026-09-20" },
      { ...base, id: "t2", due_date: "2026-09-21" },
      { ...base, id: "t3", due_date: "2026-09-22" },
      { ...base, id: "t4", due_date: "2026-09-21", status: "done" },
      { ...base, id: "t5", due_date: "2026-09-21", assigned_to: OUTRO },
      { ...base, id: "t6", due_date: null },
    ] });
    const b = ok(await minhasTarefas(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["t1", "t2"]);
  });
});
```

- [ ] **Step 3: Run** `pnpm exec vitest run lib/inicio/meu-dia.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement** — `lib/inicio/meu-dia.ts`

```ts
/**
 * "MEU DIA" — o que a pessoa logada precisa fazer hoje.
 *
 * Avisos da Central são da clínica TODA: `agent_inbox_items` não tem dono no
 * schema (spec, "Suposições"). Os outros três filtram pela pessoa.
 */
import type { createClient } from "@/lib/supabase/server";
import { janelaDeHoje, LIMITE_DE_ITENS, type Bloco, type ContextoDoInicio } from "./tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

const STATUS_DE_CONVERSA_ENCERRADA = ["resolved", "closed", "archived"];

export async function avisosAbertos(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { data, error } = await db
    .from("agent_inbox_items")
    .select("id,title,created_at")
    .eq("organization_id", ctx.orgId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((l) => ({ id: l.id, titulo: l.title, href: "/app/ai/inbox" })),
  };
}

export async function esperandoResposta(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  // PostgREST não compara duas colunas; traz as minhas com mensagem recebida e
  // filtra "última é do paciente" aqui. 200 é folga: ninguém tem 200 conversas.
  const { data, error } = await db
    .from("conversations")
    .select("id,last_inbound_at,last_outbound_at,last_message_preview,status")
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to_user_id", ctx.userId)
    .eq("is_group", false)
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const esperando = (data ?? []).filter(
    (c) =>
      !STATUS_DE_CONVERSA_ENCERRADA.includes(String(c.status)) &&
      (c.last_outbound_at == null || String(c.last_inbound_at) > String(c.last_outbound_at)),
  );
  return {
    ok: true,
    total: esperando.length,
    itens: esperando.slice(0, LIMITE_DE_ITENS).map((c) => ({
      id: c.id,
      titulo: c.last_message_preview ?? "",
      href: `/app/inbox?conversation=${c.id}`,
    })),
  };
}

export async function agendaDeHoje(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { inicio, fim } = janelaDeHoje(ctx.agora, ctx.fuso);
  const { data, error } = await db
    .from("calendar_appointments")
    .select("id,title,starts_at,status")
    .eq("organization_id", ctx.orgId)
    .eq("owner_user_id", ctx.userId)
    .neq("status", "cancelled")
    .gte("starts_at", inicio)
    .lt("starts_at", fim)
    .order("starts_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((a) => ({
      id: a.id,
      titulo: a.title ?? "",
      detalhe: a.starts_at,
      href: "/app/agenda",
    })),
  };
}

export async function minhasTarefas(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { dia } = janelaDeHoje(ctx.agora, ctx.fuso);
  const { data, error } = await db
    .from("crm_tasks")
    .select("id,title,due_date,status")
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to", ctx.userId)
    .in("status", ["pending", "in_progress"])
    .lte("due_date", dia)
    .order("due_date", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((t) => ({
      id: t.id,
      titulo: t.title,
      detalhe: t.due_date ?? undefined,
      href: "/app/tasks",
    })),
  };
}
```

> Confira no `lib/database.types.ts` que `title`, `due_date`, `last_message_preview` batem com o tipo gerado; se o typecheck reclamar de nulidade, use `?? ""` como acima. Confira também o parâmetro de query que a Inbox usa para abrir uma conversa (`grep -rn "searchParams.get(\"conversation" app/app/inbox`) e ajuste o `href` e o teste se o nome for outro.

- [ ] **Step 5: Run** `pnpm exec vitest run lib/inicio/` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/inicio/
git commit -m "feat(inicio): blocos pessoais — avisos, esperando resposta, agenda e tarefas"
```

---

### Task 3: Blocos de gestão

**Files:**
- Create: `lib/inicio/gestao.ts`, `lib/inicio/gestao.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `fakeDb` (Task 2)
- Produces:
  ```ts
  export async function configuracaoPendente(db: Db, ctx: ContextoDoInicio): Promise<Bloco>;
  export interface Numeros { conversasComPaciente: number; agendamentosCriados: number; leadsGanhos: number; }
  export async function numerosDeHoje(db: Db, ctx: ContextoDoInicio): Promise<{ ok: true; numeros: Numeros } | { ok: false }>;
  export type GastoDeIa = { ok: true; consumidoCents: number; limiteCents: number | null; pausado: boolean } | { ok: false };
  export async function gastoDeIa(db: Db, ctx: ContextoDoInicio): Promise<GastoDeIa>;
  ```

- [ ] **Step 1: Write the failing test** — `lib/inicio/gestao.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { fakeDb } from "./fake-db.test-helper";
import { configuracaoPendente, gastoDeIa, numerosDeHoje } from "./gestao";

const ORG = "org-1", OUTRA = "org-2";
const ctx = { orgId: ORG, userId: "u", agora: new Date("2026-09-21T15:00:00Z"), fuso: "America/Sao_Paulo" };

describe("configuracaoPendente", () => {
  it("acha tipo ativo sem responsável, convite vencido, WhatsApp fora e agente nunca publicado — só desta org", async () => {
    const { db } = fakeDb({
      calendar_event_types: [
        { id: "e1", organization_id: ORG, name: "Acupuntura — Dra. Ana Claudia", is_active: true, default_owner_user_id: null },
        { id: "e2", organization_id: ORG, name: "Consulta", is_active: true, default_owner_user_id: "u" },
        { id: "e3", organization_id: ORG, name: "Antigo", is_active: false, default_owner_user_id: null },
        { id: "e4", organization_id: OUTRA, name: "Outra", is_active: true, default_owner_user_id: null },
      ],
      team_invites: [
        { id: "i1", organization_id: ORG, email: "a@x.com", expires_at: "2026-09-20T00:00:00Z", accepted_at: null, revoked_at: null },
        { id: "i2", organization_id: ORG, email: "b@x.com", expires_at: "2026-09-30T00:00:00Z", accepted_at: null, revoked_at: null },
        { id: "i3", organization_id: ORG, email: "c@x.com", expires_at: "2026-09-20T00:00:00Z", accepted_at: "2026-09-19T00:00:00Z", revoked_at: null },
      ],
      channel_sessions: [
        { id: "s1", organization_id: ORG, display_name: "Recepção", status: "FAILED" },
        { id: "s2", organization_id: ORG, display_name: "Outro", status: "WORKING" },
      ],
      ai_agents: [
        { id: "g1", organization_id: ORG, name: "Isadora", published_version_id: null, archived_at: null },
        { id: "g2", organization_id: ORG, name: "Cintia", published_version_id: "v2", archived_at: null },
        { id: "g3", organization_id: ORG, name: "Velho", published_version_id: null, archived_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const b = await configuracaoPendente(db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    expect(b.itens.map((i) => i.id).sort()).toEqual(["agente:g1", "canal:s1", "convite:i1", "tipo:e1"]);
    expect(b.itens.find((i) => i.id === "tipo:e1")!.href).toBe("/app/agenda");
  });
});

describe("numerosDeHoje", () => {
  it("conta conversas com mensagem do paciente hoje, agendamentos criados hoje e leads ganhos hoje", async () => {
    const { db } = fakeDb({
      conversations: [
        { id: "c1", organization_id: ORG, is_group: false, last_inbound_at: "2026-09-21T12:00:00Z" },
        { id: "c2", organization_id: ORG, is_group: false, last_inbound_at: "2026-09-20T12:00:00Z" },
      ],
      calendar_appointments: [{ id: "a1", organization_id: ORG, created_at: "2026-09-21T11:00:00Z" }],
      crm_leads: [
        { id: "l1", organization_id: ORG, status: "won", closed_at: "2026-09-21T13:00:00Z" },
        { id: "l2", organization_id: ORG, status: "lost", closed_at: "2026-09-21T13:00:00Z" },
      ],
    });
    const r = await numerosDeHoje(db, ctx);
    expect(r).toEqual({ ok: true, numeros: { conversasComPaciente: 1, agendamentosCriados: 1, leadsGanhos: 1 } });
  });
});

describe("gastoDeIa", () => {
  it("lê consumo e limite do mês", async () => {
    const { db } = fakeDb({ ai_budgets: [
      { organization_id: ORG, current_month_consumed_cents: 1234, monthly_limit_cents: 5000, is_throttled: false, is_disabled: false },
    ] });
    expect(await gastoDeIa(db, ctx)).toEqual({ ok: true, consumidoCents: 1234, limiteCents: 5000, pausado: false });
  });
  it("sem linha de orçamento é 'sem limite', não erro", async () => {
    const { db } = fakeDb({ ai_budgets: [] });
    expect(await gastoDeIa(db, ctx)).toEqual({ ok: true, consumidoCents: 0, limiteCents: null, pausado: false });
  });
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run lib/inicio/gestao.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** — `lib/inicio/gestao.ts`

```ts
/**
 * "GESTÃO" — o que impede o CRM de funcionar direito. Só a rota decide quem vê
 * (manager/admin); estas funções não checam papel.
 *
 * Os textos dos itens de configuração vão em português CRU: a tela os passa
 * por `t()` com o nome interpolado, então aqui só vai o nome do objeto.
 */
import type { createClient } from "@/lib/supabase/server";
import { janelaDeHoje, LIMITE_DE_ITENS, type Bloco, type ContextoDoInicio, type ItemDoBloco } from "./tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

export async function configuracaoPendente(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const agora = ctx.agora.toISOString();
  const [tipos, convites, canais, agentes] = await Promise.all([
    db.from("calendar_event_types").select("id,name").eq("organization_id", ctx.orgId)
      .eq("is_active", true).is("default_owner_user_id", null).limit(50),
    db.from("team_invites").select("id,email").eq("organization_id", ctx.orgId)
      .is("accepted_at", null).is("revoked_at", null).lt("expires_at", agora).limit(50),
    db.from("channel_sessions").select("id,display_name,status").eq("organization_id", ctx.orgId)
      .neq("status", "WORKING").limit(50),
    db.from("ai_agents").select("id,name").eq("organization_id", ctx.orgId)
      .is("published_version_id", null).is("archived_at", null).limit(50),
  ]);
  if (tipos.error || convites.error || canais.error || agentes.error) return { ok: false };
  const itens: ItemDoBloco[] = [
    ...(tipos.data ?? []).map((t) => ({ id: `tipo:${t.id}`, titulo: t.name, detalhe: "sem_responsavel", href: "/app/agenda" })),
    ...(canais.data ?? []).map((c) => ({ id: `canal:${c.id}`, titulo: c.display_name ?? "WhatsApp", detalhe: "canal_fora", href: "/app/connections" })),
    ...(convites.data ?? []).map((i) => ({ id: `convite:${i.id}`, titulo: i.email, detalhe: "convite_vencido", href: "/app/team" })),
    ...(agentes.data ?? []).map((a) => ({ id: `agente:${a.id}`, titulo: a.name, detalhe: "agente_rascunho", href: `/app/ai/agents/${a.id}` })),
  ];
  return { ok: true, total: itens.length, itens: itens.slice(0, LIMITE_DE_ITENS) };
}

export interface Numeros {
  conversasComPaciente: number;
  agendamentosCriados: number;
  leadsGanhos: number;
}

export async function numerosDeHoje(
  db: Db,
  ctx: ContextoDoInicio,
): Promise<{ ok: true; numeros: Numeros } | { ok: false }> {
  const { inicio, fim } = janelaDeHoje(ctx.agora, ctx.fuso);
  const contar = { count: "exact" as const, head: true };
  const [conv, ag, leads] = await Promise.all([
    db.from("conversations").select("id", contar).eq("organization_id", ctx.orgId)
      .eq("is_group", false).gte("last_inbound_at", inicio).lt("last_inbound_at", fim),
    db.from("calendar_appointments").select("id", contar).eq("organization_id", ctx.orgId)
      .gte("created_at", inicio).lt("created_at", fim),
    db.from("crm_leads").select("id", contar).eq("organization_id", ctx.orgId)
      .eq("status", "won").gte("closed_at", inicio).lt("closed_at", fim),
  ]);
  if (conv.error || ag.error || leads.error) return { ok: false };
  return {
    ok: true,
    numeros: {
      conversasComPaciente: conv.count ?? 0,
      agendamentosCriados: ag.count ?? 0,
      leadsGanhos: leads.count ?? 0,
    },
  };
}

export type GastoDeIa =
  | { ok: true; consumidoCents: number; limiteCents: number | null; pausado: boolean }
  | { ok: false };

export async function gastoDeIa(db: Db, ctx: ContextoDoInicio): Promise<GastoDeIa> {
  const { data, error } = await db
    .from("ai_budgets")
    .select("current_month_consumed_cents,monthly_limit_cents,is_throttled,is_disabled")
    .eq("organization_id", ctx.orgId)
    .limit(1);
  if (error) return { ok: false };
  const b = data?.[0];
  if (!b) return { ok: true, consumidoCents: 0, limiteCents: null, pausado: false };
  return {
    ok: true,
    consumidoCents: b.current_month_consumed_cents ?? 0,
    limiteCents: b.monthly_limit_cents ?? null,
    pausado: Boolean(b.is_throttled || b.is_disabled),
  };
}
```

> O dublê do Task 2 devolve `count` (total filtrado) e ignora `{ head: true }` — suficiente para `numerosDeHoje`.

- [ ] **Step 4: Run** `pnpm exec vitest run lib/inicio/` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/inicio/gestao.ts lib/inicio/gestao.test.ts
git commit -m "feat(inicio): blocos de gestão — configuração pendente, números e gasto de IA"
```

---

### Task 4: Rota `GET /api/v1/inicio`

**Files:**
- Create: `app/api/v1/inicio/route.ts`, `app/api/v1/inicio/route.test.ts`

**Interfaces:**
- Consumes: todas as funções de `lib/inicio/meu-dia.ts` e `lib/inicio/gestao.ts`; `FUSO_PADRAO`.
- Produces (JSON `data`):
  ```ts
  export interface RespostaDoInicio {
    meuDia: { avisos: Bloco; esperando: Bloco; agenda: Bloco; tarefas: Bloco };
    gestao: null | { configuracao: Bloco; numeros: Awaited<ReturnType<typeof numerosDeHoje>>; gastoIa: GastoDeIa };
  }
  ```

- [ ] **Step 1: Write the failing test** — `app/api/v1/inicio/route.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import * as meuDia from "@/lib/inicio/meu-dia";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "./route";
import { fakeDb } from "@/lib/inicio/fake-db.test-helper";

const ORG = "org-1";
function comoPapel(role: string) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "u1", timezone: null }, org: { orgId: ORG, role },
  } as never);
}
async function chamar() {
  const res = await GET(new Request("http://localhost/api/v1/inicio"));
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createClient).mockResolvedValue(fakeDb({}).db as never);
});

describe("GET /api/v1/inicio", () => {
  it("colaborador recebe só 'meu dia' — gestão é null", async () => {
    comoPapel("agent");
    const d = await chamar();
    expect(d.gestao).toBeNull();
    expect(d.meuDia).toBeDefined();
  });
  it("gerente recebe gestão", async () => {
    comoPapel("manager");
    const d = await chamar();
    expect(d.gestao).not.toBeNull();
  });
  it("um bloco que lança vira {ok:false} e os outros continuam", async () => {
    comoPapel("admin");
    vi.spyOn(meuDia, "agendaDeHoje").mockRejectedValue(new Error("relation does not exist"));
    const d = (await chamar()) as { meuDia: Record<string, { ok: boolean }> };
    expect(d.meuDia.agenda).toEqual({ ok: false });
    expect(d.meuDia.avisos.ok).toBe(true);
  });
  it("preserva a negativa de autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await GET(new Request("http://localhost/api/v1/inicio"));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run app/api/v1/inicio` — Expected: FAIL.

- [ ] **Step 3: Implement** — `app/api/v1/inicio/route.ts`

```ts
import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { ok } from "@/lib/api/wrappers";
import * as meuDia from "@/lib/inicio/meu-dia";
import * as gestao from "@/lib/inicio/gestao";
import { FUSO_PADRAO, type ContextoDoInicio } from "@/lib/inicio/tipos";

/**
 * GET /api/v1/inicio — os blocos do painel Início.
 *
 * Cada bloco roda isolado (`allSettled`): um que lança — ex.: tabela que um
 * clone antigo ainda não tem — vira `{ ok:false }` e a tela avisa só nele.
 * Gestão é decidida AQUI, no servidor: esconder na tela não é permissão.
 * Spec: docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 */
async function isolado<T>(p: () => Promise<T>): Promise<T | { ok: false }> {
  try {
    return await p();
  } catch {
    return { ok: false };
  }
}

export async function GET(_req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "inicio" });
  if (!auth.ok) return auth.response;
  const db = await createClient();
  const ctx: ContextoDoInicio = {
    orgId: auth.org.orgId,
    userId: auth.user.id,
    agora: new Date(),
    fuso: auth.user.timezone ?? FUSO_PADRAO,
  };
  const veGestao = ROLE_RANK[auth.org.role] >= ROLE_RANK.manager;
  const [avisos, esperando, agenda, tarefas, configuracao, numeros, gastoIa] = await Promise.all([
    isolado(() => meuDia.avisosAbertos(db, ctx)),
    isolado(() => meuDia.esperandoResposta(db, ctx)),
    isolado(() => meuDia.agendaDeHoje(db, ctx)),
    isolado(() => meuDia.minhasTarefas(db, ctx)),
    veGestao ? isolado(() => gestao.configuracaoPendente(db, ctx)) : null,
    veGestao ? isolado(() => gestao.numerosDeHoje(db, ctx)) : null,
    veGestao ? isolado(() => gestao.gastoDeIa(db, ctx)) : null,
  ]);
  return ok(
    {
      meuDia: { avisos, esperando, agenda, tarefas },
      gestao: veGestao ? { configuracao, numeros, gastoIa } : null,
    },
    { requestId },
  );
}
```

> `vi.spyOn` em módulo ESM exige que a rota chame `meuDia.agendaDeHoje` via namespace (como acima), não por import nomeado. Se o spy não pegar (Vitest com ESM estrito), troque por `vi.mock("@/lib/inicio/meu-dia", async (orig) => ({ ...(await orig()), agendaDeHoje: vi.fn().mockRejectedValue(new Error("x")) }))` num `describe` separado.

- [ ] **Step 4: Run** `pnpm exec vitest run app/api/v1/inicio lib/inicio` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/v1/inicio
git commit -m "feat(inicio): rota que reúne os blocos, com gestão decidida no servidor"
```

---

### Task 5: Tela, porta no menu e primeira tela

**Files:**
- Create: `app/app/inicio/page.tsx`, `app/app/inicio/_components/PainelInicio.tsx`
- Modify: `lib/navigation/catalogo.ts` (antes da entrada `/app/inbox`, ~linha 107), `lib/navigation/interface.ts:93-100`, `tests/unit/interface-por-vinculo.test.ts`, `lib/i18n/dicionario.ts`

**Interfaces:**
- Consumes: `RespostaDoInicio` (Task 4) via `GET /api/v1/inicio`; `/api/v1/health` (`data.status`, `data.version`).

- [ ] **Step 1: Failing test for home** — em `tests/unit/interface-por-vinculo.test.ts`, adicione:

```ts
it("a primeira tela é o Início quando ele está visível", () => {
  expect(homeDaInterface(undefined, false, "agent")).toBe("/app/inicio");
  expect(homeDaInterface(undefined, false, "admin")).toBe("/app/inicio");
});
```

Run `pnpm exec vitest run tests/unit/interface-por-vinculo.test.ts` — Expected: FAIL (recebe `/app/inbox`).

- [ ] **Step 2: Porta no catálogo** — em `lib/navigation/catalogo.ts`, logo antes do bloco `href: "/app/inbox"`:

```ts
  {
    // O painel que junta o que cada um precisa fazer hoje e, para quem
    // administra, o que impede o CRM de funcionar. É a primeira tela
    // (`homeDaInterface`). Spec: docs/superpowers/specs/2026-09-21-painel-inicio-design.md
    href: "/app/inicio",
    label: "Início",
    description: "O que precisa da sua atenção hoje, num lugar só.",
    icon: "House",
    group: "atendimento",
    sidebar: true,
  },
```

> Confirme que `"House"` existe no mapa de ícones (`grep -n '"House"\|House,' lib/ui/icons.ts*`); se não, use um ícone já exportado ali (ex.: `"SquaresFour"`), sem adicionar dependência.

- [ ] **Step 3: Home** — `lib/navigation/interface.ts`:

```ts
export function homeDaInterface(raw: unknown, platform: boolean, role: Role | null): string {
  const visible = destinosDaInterface(raw, platform, role);
  return (
    visible.find((d) => d.href === "/app/inicio")?.href ??
    visible.find((d) => d.href === "/app/inbox")?.href ??
    visible.find((d) => !essencial(d, role, platform))?.href ??
    "/app/settings/profile"
  );
}
```

Run `pnpm exec vitest run tests/unit/interface-por-vinculo.test.ts tests/unit/navegacao-completude.test.ts tests/unit/navegacao-registry.test.ts` — Expected: PASS. Se outro caso do arquivo esperava `/app/inbox` com preset padrão, atualize a expectativa para `/app/inicio` (a mudança é deliberada) — não mude casos com interface granular que já excluem o Início.

- [ ] **Step 4: Página** — `app/app/inicio/page.tsx`

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { PainelInicio } from "./_components/PainelInicio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Início" };

export default async function InicioPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app/settings/profile");
  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Início")}</h1>
        <p className="text-sm text-muted-foreground">{t("O que precisa da sua atenção hoje, num lugar só.")}</p>
      </header>
      <PainelInicio />
    </div>
  );
}
```

- [ ] **Step 5: Componente** — `app/app/inicio/_components/PainelInicio.tsx`

```tsx
"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import type { Bloco } from "@/lib/inicio/tipos";

type Numeros = { ok: true; numeros: { conversasComPaciente: number; agendamentosCriados: number; leadsGanhos: number } } | { ok: false };
type Gasto = { ok: true; consumidoCents: number; limiteCents: number | null; pausado: boolean } | { ok: false };
type Resposta = {
  meuDia: { avisos: Bloco; esperando: Bloco; agenda: Bloco; tarefas: Bloco };
  gestao: null | { configuracao: Bloco; numeros: Numeros; gastoIa: Gasto };
};

const MOTIVO: Record<string, string> = {
  sem_responsavel: "sem responsável na agenda",
  canal_fora: "WhatsApp desconectado",
  convite_vencido: "convite vencido",
  agente_rascunho: "agente nunca publicado",
};

function Cartao({ titulo, children, verTodos }: { titulo: string; children: React.ReactNode; verTodos?: string }) {
  const t = useT();
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">{titulo}</h2>
        {verTodos ? <Link className="text-sm underline" href={verTodos}>{t("Ver todos")}</Link> : null}
      </div>
      {children}
    </section>
  );
}

function ListaDoBloco({ bloco, motivo }: { bloco: Bloco | null | undefined; motivo?: boolean }) {
  const t = useT();
  if (!bloco || !bloco.ok) return <p role="alert" className="text-sm">{t("Não consegui carregar este bloco.")}</p>;
  if (bloco.total === 0) return <p className="text-sm text-muted-foreground">{t("Tudo em dia ✓")}</p>;
  return (
    <>
      <p className="mb-2 text-3xl font-semibold">{bloco.total}</p>
      <ul className="space-y-1">
        {bloco.itens.map((i) => (
          <li key={i.id}>
            <Link className="flex min-h-11 items-center justify-between gap-2 rounded-md px-2 hover:bg-muted" href={i.href}>
              <span className="truncate">{i.titulo}{motivo && i.detalhe ? ` — ${t(MOTIVO[i.detalhe] ?? i.detalhe)}` : ""}</span>
              <span className="text-sm underline">{t("Resolver")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PainelInicio() {
  const t = useT();
  const q = useQuery({
    queryKey: ["inicio"],
    queryFn: async () => (await apiClient.get<{ data: Resposta }>("/api/v1/inicio")).data,
    refetchOnWindowFocus: true,
  });
  const saude = useQuery({
    queryKey: ["inicio", "saude"],
    queryFn: async () => (await apiClient.get<{ data: { status: string; version?: string } }>("/api/v1/health")).data,
    enabled: Boolean(q.data?.gestao),
    refetchOnWindowFocus: true,
  });
  if (q.isLoading) return <p>{t("Carregando…")}</p>;
  if (q.isError || !q.data) return <p role="alert">{t("Não foi possível carregar o painel. Tente novamente.")}</p>;
  const { meuDia, gestao } = q.data;
  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-3 text-lg font-semibold">{t("Meu dia")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Cartao titulo={t("Avisos da Central")} verTodos="/app/ai/inbox"><ListaDoBloco bloco={meuDia.avisos} /></Cartao>
          <Cartao titulo={t("Pacientes esperando resposta")} verTodos="/app/inbox"><ListaDoBloco bloco={meuDia.esperando} /></Cartao>
          <Cartao titulo={t("Minha agenda de hoje")} verTodos="/app/agenda"><ListaDoBloco bloco={meuDia.agenda} /></Cartao>
          <Cartao titulo={t("Minhas tarefas")} verTodos="/app/tasks"><ListaDoBloco bloco={meuDia.tarefas} /></Cartao>
        </div>
      </div>
      {gestao ? (
        <div>
          <h2 className="mb-3 text-lg font-semibold">{t("Gestão")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Cartao titulo={t("Configuração pendente")}><ListaDoBloco bloco={gestao.configuracao} motivo /></Cartao>
            <Cartao titulo={t("Números de hoje")} verTodos="/app/metrics">
              {gestao.numeros.ok ? (
                <ul className="space-y-1 text-sm">
                  <li>{t("Conversas com pacientes")}: <b>{gestao.numeros.numeros.conversasComPaciente}</b></li>
                  <li>{t("Agendamentos criados")}: <b>{gestao.numeros.numeros.agendamentosCriados}</b></li>
                  <li>{t("Negócios ganhos")}: <b>{gestao.numeros.numeros.leadsGanhos}</b></li>
                </ul>
              ) : <p role="alert" className="text-sm">{t("Não consegui carregar este bloco.")}</p>}
            </Cartao>
            <Cartao titulo={t("Gasto com IA no mês")}>
              {gestao.gastoIa.ok ? (
                <p className="text-sm">
                  <b className="text-2xl">R$ {(gestao.gastoIa.consumidoCents / 100).toFixed(2)}</b>
                  {gestao.gastoIa.limiteCents != null
                    ? ` ${t("de")} R$ ${(gestao.gastoIa.limiteCents / 100).toFixed(2)}`
                    : ` · ${t("sem limite configurado")}`}
                  {gestao.gastoIa.pausado ? ` · ${t("IA pausada por orçamento")}` : ""}
                </p>
              ) : <p role="alert" className="text-sm">{t("Não consegui carregar este bloco.")}</p>}
            </Cartao>
            <Cartao titulo={t("Sistema")}>
              {saude.data?.status === "healthy" ? (
                <p className="text-sm">🟢 {t("Tudo no ar")}{saude.data.version ? ` · ${t("versão")} ${saude.data.version}` : ""}</p>
              ) : saude.isLoading ? <p className="text-sm">{t("Carregando…")}</p>
                : <p role="alert" className="text-sm">🔴 {t("Algum serviço está fora do ar. Avise o suporte.")}</p>}
            </Cartao>
          </div>
        </div>
      ) : null}
    </div>
  );
}
```

> A moeda está fixa em BRL porque `ai_budgets` não guarda moeda e a instalação é brasileira; se o repo já tiver helper de dinheiro (`grep -rn "formatCents\|formatarCentavos" lib`), use-o.

- [ ] **Step 6: i18n** — em `lib/i18n/dicionario.ts`, junto das entradas de navegação, acrescente (uma linha por texto, estilo do arquivo):

```ts
  // Painel Início (app/app/inicio).
  "Início": { es: "Inicio" },
  "O que precisa da sua atenção hoje, num lugar só.": { es: "Lo que necesita tu atención hoy, en un solo lugar." },
  "Meu dia": { es: "Mi día" },
  "Gestão": { es: "Gestión" },
  "Avisos da Central": { es: "Avisos de la Central" },
  "Pacientes esperando resposta": { es: "Pacientes esperando respuesta" },
  "Minha agenda de hoje": { es: "Mi agenda de hoy" },
  "Minhas tarefas": { es: "Mis tareas" },
  "Configuração pendente": { es: "Configuración pendiente" },
  "Números de hoje": { es: "Números de hoy" },
  "Gasto com IA no mês": { es: "Gasto de IA en el mes" },
  "Sistema": { es: "Sistema" },
  "Ver todos": { es: "Ver todos" },
  "Resolver": { es: "Resolver" },
  "Tudo em dia ✓": { es: "Todo al día ✓" },
  "Não consegui carregar este bloco.": { es: "No pude cargar este bloque." },
  "Não foi possível carregar o painel. Tente novamente.": { es: "No se pudo cargar el panel. Inténtalo de nuevo." },
  "sem responsável na agenda": { es: "sin responsable en la agenda" },
  "WhatsApp desconectado": { es: "WhatsApp desconectado" },
  "convite vencido": { es: "invitación vencida" },
  "agente nunca publicado": { es: "agente nunca publicado" },
  "Conversas com pacientes": { es: "Conversaciones con pacientes" },
  "Agendamentos criados": { es: "Citas creadas" },
  "Negócios ganhos": { es: "Negocios ganados" },
  "sem limite configurado": { es: "sin límite configurado" },
  "IA pausada por orçamento": { es: "IA pausada por presupuesto" },
  "Tudo no ar": { es: "Todo en línea" },
  "versão": { es: "versión" },
  "Algum serviço está fora do ar. Avise o suporte.": { es: "Algún servicio está caído. Avisa al soporte." },
```

> Antes de colar, `grep -n '^  "Resolver"\|^  "Sistema"\|^  "Carregando…"\|^  "de":' lib/i18n/dicionario.ts` — chave que já existe NÃO pode ser duplicada (objeto literal com chave repetida é erro de lint). Remova da lista as que já existem.

- [ ] **Step 7: Run** `pnpm typecheck && pnpm exec vitest run tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/navegacao-completude.test.ts tests/unit/interface-por-vinculo.test.ts tests/unit/branding.test.ts` — Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/app/inicio lib/navigation lib/i18n/dicionario.ts tests/unit/interface-por-vinculo.test.ts
git commit -m "feat(inicio): tela Início como primeira tela, com porta no menu"
```

---

### Task 6: Prova pela tela, fragmento e suíte

**Files:**
- Create: `tests/e2e/painel-inicio.spec.ts`, `.changes/painel-inicio.md`
- Modify: `.github/workflows/e2e.yml` (adicionar a spec numa `SPECS_PARTE_*` — exigido por `tests/unit/e2e-cobertura-completa.test.ts`), `docs/testing/user-journey-map.md`

- [ ] **Step 1: Spec Playwright** — copie login/fixtures da spec mais parecida (`ls tests/e2e | grep -i agenda`; use o helper de login que ela usa). Casos:

```ts
import { expect, test } from "@playwright/test";
// importe aqui o mesmo helper de login/seed que tests/e2e/<spec-de-agenda>.spec.ts usa

test("admin cai no Início e vê Meu dia + Gestão", async ({ page }) => {
  // login como admin (helper)
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/inicio$/);
  await expect(page.getByRole("heading", { name: "Meu dia" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gestão" })).toBeVisible();
});

test("tipo de atendimento sem responsável aparece em Configuração pendente e leva à agenda", async ({ page }) => {
  // seed: calendar_event_types ativo, default_owner_user_id null, name "Acupuntura E2E" (helper de seed/SQL da spec copiada)
  // login como admin
  await page.goto("/app/inicio");
  const item = page.getByRole("link", { name: /Acupuntura E2E — sem responsável na agenda/ });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(/\/app\/agenda/);
});

test("colaborador vê só Meu dia", async ({ page }) => {
  // login como agent (helper)
  await page.goto("/app/inicio");
  await expect(page.getByRole("heading", { name: "Meu dia" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gestão" })).toHaveCount(0);
});
```

> Os comentários acima marcam o ponto exato onde entra o helper existente do repo — não invente helper novo; se a spec copiada semeia via SQL, semeie igual. Salve screenshot em `.superpowers/evidence/painel-inicio-*.png`.

- [ ] **Step 2: Registrar a spec no CI** — em `.github/workflows/e2e.yml`, adicione `painel-inicio.spec.ts` à `SPECS_PARTE_*` com menos specs. Run `pnpm exec vitest run tests/unit/e2e-cobertura-completa.test.ts` — Expected: PASS.

- [ ] **Step 3: Fragmento** — `.changes/painel-inicio.md`

```md
---
impacto: capacidade_nova
secao: adicionado
titulo: Painel Início na primeira tela
---

Ao entrar no CRM, cada pessoa vê seus avisos, pacientes esperando resposta, agenda
e tarefas do dia. Gerentes e administradores veem também configuração pendente
(ex.: tipo de atendimento sem responsável), números do dia, gasto com IA e se o
sistema está no ar.
```

Run `pnpm release:conferir` — Expected: fragmento válido.

- [ ] **Step 4: Mapa de jornadas** — em `docs/testing/user-journey-map.md`, acrescente um caso `[P0]` "Primeira tela após login é o Início" apontando para `tests/e2e/painel-inicio.spec.ts`.

- [ ] **Step 5: Suíte completa**

```bash
pnpm typecheck; echo "typecheck=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "lint=$?"
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "^ *(Test Files|Tests|Errors) " /tmp/vt.log
```

Expected: `typecheck=0`, `lint=0`, `exit=0`.

- [ ] **Step 6: Prova em ambiente fresco** — conforme CLAUDE.md › QA Visual: `pnpm build && pnpm start` contra Supabase local pg15 com `baseline.sql` + `scripts/bootstrap-owner.ts`; rode `pnpm exec playwright test tests/e2e/painel-inicio.spec.ts`. Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/painel-inicio.spec.ts .github/workflows/e2e.yml .changes/painel-inicio.md docs/testing/user-journey-map.md
git commit -m "test(inicio): prova pela tela, fragmento de release e jornada P0"
```
