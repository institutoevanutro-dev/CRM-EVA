import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  runSilenceSweep,
  type SilenceSweepDb,
  type SilencePointer,
} from "@/lib/followup/silence-sweep";
import { isPointerEnabledForAutomaticTrigger, type FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import type { FlowGraph } from "@/lib/followup/graph-schema";

/**
 * Task 8.1 — gatilho de silêncio (varredura TIME-DRIVEN no cron) contra
 * Postgres real. DESKCOMM_GOV_INVARIANTS_EDIT=1 — arquivo NOVO desta sessão
 * (tests/invariants/** está congelado pro resto, não para arquivos próprios).
 *
 * Congela: (1) pointer silence habilitado no gate + contato silêncio >
 * threshold → exatamente 1 enrollment nascendo no nó trigger; rodar a
 * varredura DE NOVO não duplica (unique-live, `idx_followup_enrollments_one_live`);
 * (2) o MESMO cenário mas SEM nenhum agente publicado habilitando o pointer →
 * 0 enrollments (prova que o gate é de fato chamado, não só importado);
 * (3) contato silencioso HÁ MENOS que o threshold → não enrolla (boundary);
 * silêncio EXATAMENTE igual ao threshold → enrolla (`<=`, não `<`);
 * (4) `isPointerEnabledForAutomaticTrigger` contra `ai_agent_versions` REAL
 * (não o fake hand-rolled de agent-followup-gate.test.ts): publicado+
 * habilitado+pointer-membro → true; rascunho (não publicado) → false;
 * enabled=false → false; pointer de OUTRA org → false (reviewer Minor #2 da
 * Task 7.2 — a task que primeiro CONSOME o gate é quem prova a query real);
 * (5) redução anti-spam (review pós-approval, o gap coberto agora): contato
 * com 2 conversas (1 velha silenciosa + 1 recente dentro do threshold) NÃO
 * enrolla — prova que a redução pega o `last_inbound_at` MAIS RECENTE por
 * contato, não a 1ª conversa velha encontrada; contato cuja única conversa
 * nunca recebeu inbound (`last_inbound_at is null`) também NÃO enrolla —
 * "nunca conversou" ≠ "está em silêncio", sem mass-enroll de contato novo.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

// `loadActiveSilencePointers` é GLOBAL (cross-org, mesmo desenho de
// `fn_claim_due_followup_enrollments`) — um pointer kind='silence' de um `it`
// anterior (status='active' pra sempre, nada o desativa) seria re-escaneado
// pelo `it` seguinte e contaminaria pointers_scanned/pointers_gated_out (mesma
// classe de flake já resolvida em followup-engine.test.ts, Task 5.2 fix 2).
// Escopo do delete: só kind='silence' — não toca pointers de OUTROS arquivos
// (reactivity/engine/turn-bridge nunca usam kind='silence'). Cascade:
// `followup_enrollments.pointer_id` tem ON DELETE CASCADE (migration 0054).
beforeEach(async () => {
  await pool.query(`delete from followup_flow_pointers where trigger_config->>'kind' = 'silence'`);
});

// ---- pg-backed SilenceSweepDb (test-only; prod usa createSupabaseSilenceSweepDb) ----

/**
 * O SEGUNDO IMPLEMENTADOR DE `SilenceSweepDb` — e o primeiro é
 * `createSupabaseSilenceSweepDb`, em `lib/followup/silence-sweep.ts`.
 *
 * A LÓGICA testada aqui é a real: este arquivo importa e chama
 * `runSilenceSweep`. O que é dublê é a BORDA de acesso a dados — a produção
 * fala com o PostgREST e o `test:db` sobe só o Postgres, então cada método
 * abaixo traduz a consulta de lá para SQL. Dois implementadores do mesmo
 * contrato, e eles têm de concordar.
 *
 * ⚠️ Eles JÁ divergiram, e o custo apareceu no PR #420 (@automatikpg-ux): a
 * produção ganhou `.not("status","in", …)` para não cobrar quem um humano já
 * encerrou, e esta cópia ficou sem o filtro. Os dois casos que aquele PR
 * escreveu para provar a intenção reprovaram medindo A CÓPIA, não o original.
 *
 * ═══ O que a constante compartilhada garante, e o que NÃO garante ═══
 *
 * O filtro abaixo é montado a partir de `CONVERSATION_TERMINAL_STATUSES`, a
 * mesma que a produção usa — e não de `'closed','archived'` escrito à mão. A
 * diferença não é cosmética: acrescentar um status terminal passa a mudar os
 * DOIS lados no mesmo commit, sem ninguém precisar lembrar deste arquivo.
 *
 * Isso prende o **valor**. Não prende a **forma**: um `.eq()` novo na produção
 * que este SQL não tenha continua invisível daqui. Esse eixo é dívida
 * declarada, com item de plano próprio — a pergunta dele é "como fazer os dois
 * adaptadores passarem pela mesma bateria de contrato", e não cabe num PR de
 * contribuidor. Escrever o escopo é o que impede esta cerca de anestesiar quem
 * vier depois achando que ela cobre tudo.
 */
function silenceSweepDb(): SilenceSweepDb {
  return {
    async loadActiveSilencePointers(): Promise<SilencePointer[]> {
      const { rows } = await pool.query<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: { kind: string; params?: { threshold_minutes: number; segments?: string[] } };
        active_since: Date;
      }>(
        `select id, organization_id, active_version_id, trigger_config, active_since
         from followup_flow_pointers
         where status = 'active' and active_version_id is not null`,
      );
      const pointers: SilencePointer[] = [];
      for (const row of rows) {
        if (row.trigger_config.kind !== "silence" || !row.active_version_id) continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          threshold_minutes: row.trigger_config.params!.threshold_minutes,
          segments: row.trigger_config.params!.segments ?? [],
          active_since: row.active_since.toISOString(),
        });
      }
      return pointers;
    },
    // O seed deste arquivo não cria mensagens: a última entrada é o
    // `last_inbound_at` da conversa, e por isso `sent_at` e `created_at` da
    // mensagem qualificante saem iguais aqui (na produção são duas colunas).
    async loadSilentContacts(orgId, cutoffIso, segments) {
      const { rows } = await pool.query<{
        contact_id: string; last_inbound_at: Date; tags: string[]; is_blocked: boolean; is_anonymized: boolean;
      }>(
        `select conv.contact_id, max(conv.last_inbound_at) as last_inbound_at,
                c.tags as tags, c.is_blocked as is_blocked, c.is_anonymized as is_anonymized
         from conversations conv
         join contacts c on c.id = conv.contact_id
         where conv.organization_id = $1 and conv.last_inbound_at is not null
           and conv.status <> all($2::text[])
         group by conv.contact_id, c.tags, c.is_blocked, c.is_anonymized`,
        [orgId, CONVERSATION_TERMINAL_STATUSES],
      );
      const cutoff = new Date(cutoffIso).getTime();
      return rows
        .filter((r) => !r.is_blocked && !r.is_anonymized)
        .filter((r) => r.last_inbound_at.getTime() <= cutoff)
        .filter((r) => segments.length === 0 || segments.some((s) => r.tags.includes(s)))
        .map((r) => ({
          contact_id: r.contact_id,
          ultima_entrada_em: r.last_inbound_at.toISOString(),
          ultima_entrada_gravada_em: r.last_inbound_at.toISOString(),
        }));
    },
    // Mesma pergunta do adaptador de produção: maior started_at deste ponteiro,
    // qualquer status, a partir de `desde`.
    async loadUltimaInscricaoNoPonteiro(orgId, pointerId, contactIds, desdeIso) {
      const { rows } = await pool.query<{ contact_id: string; ultima: Date }>(
        `select contact_id, max(started_at) as ultima from followup_enrollments
          where organization_id = $1 and pointer_id = $2 and contact_id = any($3::uuid[])
            and started_at >= $4
          group by contact_id`,
        [orgId, pointerId, contactIds, desdeIso],
      );
      return new Map(rows.map((r) => [r.contact_id, r.ultima.toISOString()]));
    },
    // Mesma pergunta do adaptador de produção: vivo em QUALQUER fluxo da org.
    async loadContatosComInscricaoViva(orgId, contactIds) {
      const { rows } = await pool.query<{ contact_id: string }>(
        `select distinct contact_id from followup_enrollments
          where organization_id = $1 and contact_id = any($2::uuid[])
            and status in ('active','waiting_reply','paused_handoff','paused_manual')`,
        [orgId, contactIds],
      );
      return new Set(rows.map((r) => r.contact_id));
    },
    async loadTriggerNodeId(orgId, versionId) {
      const { rows } = await pool.query<{ graph: FlowGraph }>(
        `select graph from followup_flow_versions where organization_id = $1 and id = $2`,
        [orgId, versionId],
      );
      if (rows.length === 0) return null;
      return rows[0]!.graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },
    async insertEnrollment(input) {
      try {
        await pool.query(
          `insert into followup_enrollments
             (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, agent_id)
           values ($1, $2, $3, $4, $5, 'active', $6, $7)`,
          [
            input.organization_id,
            input.pointer_id,
            input.version_id,
            input.contact_id,
            input.current_node_id,
            input.next_eval_at,
            input.agent_id,
          ],
        );
        return { inserted: true };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") return { inserted: false };
        throw err;
      }
    },
  };
}

// ---- pg-backed FollowupGateDb (mirrors createSupabaseFollowupGateDb's query, against real ai_agent_versions) ----

function pgGateDb(): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents(orgId) {
      const { rows } = await pool.query<{ agent_id: string; followup: unknown }>(
        `select agent_id, followup from ai_agent_versions where organization_id = $1 and status = 'published'`,
        [orgId],
      );
      const byAgent = new Map<string, Set<string>>();
      for (const row of rows) {
        const f = row.followup as { enabled?: unknown; flow_pointer_ids?: unknown } | null;
        if (!f || f.enabled !== true || !Array.isArray(f.flow_pointer_ids)) continue;
        const set = byAgent.get(row.agent_id) ?? new Set<string>();
        for (const id of f.flow_pointer_ids) if (typeof id === "string") set.add(id);
        if (set.size > 0) byAgent.set(row.agent_id, set);
      }
      return [...byAgent].map(([agentId, ids]) => ({ agentId, pointerIds: [...ids] }));
    },
  };
}

// ---- seed helpers ----

let orgSeq = 0;
function nextOrgId(): string {
  orgSeq += 1;
  return `dddddd${String(orgSeq).padStart(2, "0")}-0000-4000-8000-000000000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `followup-silence-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContact(
  org: string,
  opts?: { tags?: string[]; isBlocked?: boolean; isAnonymized?: boolean },
): Promise<string> {
  // `anonymized_at` acompanha por causa do CHECK `contacts_anonymized_locked`.
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, tags, is_blocked, is_anonymized, anonymized_at)
     values ($1, 'Silence Contact', $2, $3, $4, case when $4 then now() end) returning id`,
    [org, opts?.tags ?? [], opts?.isBlocked ?? false, opts?.isAnonymized ?? false],
  );
  return rows[0]!.id;
}

async function seedChannelSession(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `silence-session-${Date.now()}-${Math.random()}`],
  );
  return rows[0]!.id;
}

/** `agoMinutes=null` → conversa sem last_inbound_at (nunca recebeu inbound). */
async function seedConversation(org: string, contactId: string, agoMinutes: number | null): Promise<string> {
  const sessionId = await seedChannelSession(org);
  const lastInboundExpr = agoMinutes === null ? "null" : `now() - interval '${agoMinutes} minutes'`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1, $2, $3, 'open', false, ${lastInboundExpr}) returning id`,
    [org, contactId, sessionId],
  );
  return rows[0]!.id;
}

/** Mesmo que `seedConversation`, mas com `status` explícito — pra provar que uma conversa
 *  CLOSED/ARCHIVED não conta como silêncio (um humano encerrou; o fluxo não está mais ativo). */
async function seedConversationComStatus(
  org: string,
  contactId: string,
  agoMinutes: number,
  status: string,
): Promise<string> {
  const sessionId = await seedChannelSession(org);
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1, $2, $3, $4, false, now() - interval '${agoMinutes} minutes') returning id`,
    [org, contactId, sessionId, status],
  );
  return rows[0]!.id;
}

/** Mesmo que `seedConversation`, mas com `last_inbound_at` EXATO (ISO), não relativo a `now()`
 *  do Postgres — necessário pro teste de boundary exato (evita drift entre `now()` do DB e o
 *  `clock()` injetado no sweep, que roda em JS). */
async function seedConversationAt(org: string, contactId: string, atIso: string): Promise<string> {
  const sessionId = await seedChannelSession(org);
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1, $2, $3, 'open', false, $4) returning id`,
    [org, contactId, sessionId, atIso],
  );
  return rows[0]!.id;
}

/**
 * `activeSince` é a vigência do ponteiro (migration 0324). O padrão é 30 dias
 * atrás, porque os casos deste arquivo semeiam silêncio NO PASSADO e a regra
 * "sem passado" recusaria silêncio anterior a ela. `"now"` = vigência agora.
 */
async function seedSilenceFlow(
  org: string,
  opts?: { thresholdMinutes?: number; segments?: string[]; activeSince?: "now" },
): Promise<{ pointerId: string; versionId: string }> {
  const graph: FlowGraph = {
    nodes: [
      { id: "t1", type: "trigger", label: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [{ id: "t1-e1", source: "t1", target: "e1", priority: 0, condition: { type: "always" } }],
  };
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(graph)],
  );
  const versionId = versionRows[0]!.id;
  const triggerConfig = {
    kind: "silence",
    params: { threshold_minutes: opts?.thresholdMinutes ?? 60, segments: opts?.segments ?? [] },
  };
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config, active_since)
     values ($1, $2, 'active', $3, $4, case when $5 then now() else now() - interval '30 days' end) returning id`,
    [org, `Silence Flow ${Date.now()}-${Math.random()}`, versionId, JSON.stringify(triggerConfig), opts?.activeSince === "now"],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedPublishedAgentVersion(
  org: string,
  opts: { status?: string; enabled?: boolean; pointerIds?: string[]; agentId?: string },
): Promise<string> {
  const sessionId = await seedChannelSession(org);
  const { rows: agentRows } = await pool.query<{ id: string }>(
    opts.agentId
      ? `insert into ai_agents (id, organization_id, name, system_prompt) values ($3, $1, $2, 'prompt') returning id`
      : `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt') returning id`,
    opts.agentId
      ? [org, `Silence Gate Agent ${Date.now()}-${Math.random()}`, opts.agentId]
      : [org, `Silence Gate Agent ${Date.now()}-${Math.random()}`],
  );
  const agentId = agentRows[0]!.id;
  const followup = { enabled: opts.enabled ?? true, flow_pointer_ids: opts.pointerIds ?? [] };
  await pool.query(
    `insert into ai_agent_versions
       (organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status, followup)
     values ($1, $2, 1, 'prompt', 'anthropic', 'claude-sonnet-4-6', $3, $4, $5)`,
    [org, agentId, sessionId, opts.status ?? "published", JSON.stringify(followup)],
  );
  return agentId;
}

async function countEnrollments(pointerId: string, contactId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from followup_enrollments where pointer_id = $1 and contact_id = $2`,
    [pointerId, contactId],
  );
  return Number(rows[0]!.n);
}

const CLOCK = () => new Date();

// ---- 1. sweep enrolla + idempotência ------------------------------------

describe("runSilenceSweep — enrolla contato silencioso gateado, sem duplicar", () => {
  it("pointer silence habilitado + contato silêncio > threshold → 1 enrollment; 2ª varredura não duplica", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId, versionId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90); // silencioso há 90min > threshold 30min

    const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };

    const summary1 = await runSilenceSweep(deps);
    expect(summary1.pointers_scanned).toBeGreaterThanOrEqual(1);
    expect(summary1.enrolled).toBe(1);
    expect(summary1.skipped_existing).toBe(0);

    const enrollment = await pool.query<{ current_node_id: string; status: string }>(
      `select current_node_id, status from followup_enrollments where pointer_id = $1 and contact_id = $2`,
      [pointerId, contactId],
    );
    expect(enrollment.rows).toHaveLength(1);
    expect(enrollment.rows[0]!.current_node_id).toBe("t1");
    expect(enrollment.rows[0]!.status).toBe("active");

    // 2ª varredura: mesmo episódio — nem tenta o insert, nem conta como
    // skipped_existing (que audita). Vivo DESTE ponteiro não gera auditoria.
    const summary2 = await runSilenceSweep(deps);
    expect(summary2.enrolled).toBe(0);
    expect(summary2.skipped_same_episode).toBeGreaterThanOrEqual(1);
    expect(summary2.skipped_existing).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(1);

    expect(versionId).toBeTruthy(); // sanity — version foi realmente usada (current_node_id veio do grafo pinado nela)
  });
});

// ---- 2. gate-out: sem agente publicado habilitando → 0 enrollments -----

describe("runSilenceSweep — gate-out (nenhum agente publicado habilita o pointer)", () => {
  it("mesmo contato silencioso, SEM agente publicado com followup.enabled → 0 enrollments (prova que o gate é chamado)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    // nenhum ai_agent_versions publicado nesta org habilitando o pointer
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("agente existe mas com followup.enabled=false → gate-out também", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: false, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });
});

// ---- 3. boundary: silêncio < threshold não enrolla ----------------------

describe("runSilenceSweep — boundary de threshold", () => {
  it("contato silencioso há MENOS que threshold_minutes → não enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 10); // só 10min de silêncio, threshold=60

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBe(0); // o gate passou — não é isso que bloqueou
    expect(summary.enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("silêncio EXATAMENTE igual ao threshold (at === cutoff) → enrolla (silêncio é <=, não <)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const thresholdMinutes = 60;
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);

    // clock() fixo (não `new Date()` a cada chamada) pra `cutoff` do sweep e o
    // `last_inbound_at` semeado baterem no MESMO instante, sem drift de execução.
    const refTime = new Date();
    const cutoff = new Date(refTime.getTime() - thresholdMinutes * 60_000);
    await seedConversationAt(org, contactId, cutoff.toISOString());

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: () => refTime });
    expect(summary.enrolled).toBe(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(1);
  });
});

// ---- 3b. redução anti-spam (o ponto mais arriscado da lógica) -----------

describe("runSilenceSweep — redução anti-spam (multi-conversa + never-inbound)", () => {
  it("contato com 2 conversas — 1 antiga silenciosa + 1 RECENTE (dentro do threshold) → NÃO enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    // conversa OLD: 120min de silêncio (> threshold 60, sozinha enrollaria).
    await seedConversation(org, contactId, 120);
    // conversa NEW: 5min — o contato respondeu recentemente por OUTRA conversa.
    await seedConversation(org, contactId, 5);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBe(0); // não foi o gate que bloqueou
    expect(summary.enrolled).toBe(0); // a redução MAX(last_inbound_at) pegou a conversa recente, não a velha
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("única conversa está CLOSED (humano encerrou) e silenciosa há mais que o threshold → NÃO enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversationComStatus(org, contactId, 120, "closed");

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("única conversa está ARCHIVED e silenciosa há mais que o threshold → NÃO enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversationComStatus(org, contactId, 120, "archived");

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("conversa CLOSED antiga + conversa OPEN silenciosa (> threshold) do mesmo contato → enrolla pela ABERTA", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversationComStatus(org, contactId, 200, "closed"); // ignorada — não é a que decide
    await seedConversation(org, contactId, 90); // aberta, silenciosa > threshold

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.enrolled).toBe(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(1);
  });

  it("contato cuja ÚNICA conversa nunca recebeu inbound (last_inbound_at NULL) → NÃO enrolla", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 60 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, null); // nunca recebeu inbound — não é "silêncio", é ausência de histórico

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });
});

// ---- 3c. anonimizado fica fora -----------------------------------------

describe("runSilenceSweep — contato anonimizado não entra", () => {
  // ⚠️ Este caso prova o ESPELHO em SQL deste arquivo, não a consulta de
  // produção: o filtro mora no adaptador, e o adaptador aqui é dublê (ver o
  // cabeçalho de `tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts`).
  // Quem prova a produção é `lib/followup/silence-sweep-consultas.test.ts`.
  it("anonimizado calado há 90 min, fluxo armado → 0 inscrições em 3 varreduras", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org, { isAnonymized: true });
    await seedConversation(org, contactId, 90);

    const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };
    for (let i = 0; i < 3; i++) expect((await runSilenceSweep(deps)).enrolled).toBe(0);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });
});

// ---- 3d. sem passado: silêncio anterior à vigência do ponteiro -----------

describe("runSilenceSweep — sem passado (active_since)", () => {
  it("fluxo que passou a valer AGORA não cobra quem calou antes → 0 inscrições", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30, activeSince: "now" });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.pointers_gated_out).toBe(0);
    expect(summary.skipped_before_activation).toBeGreaterThanOrEqual(1);
    expect(await countEnrollments(pointerId, contactId)).toBe(0);
  });

  it("desativar e publicar de novo zera a vigência: quem calou antes deixa de entrar", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 }); // vigência há 30 dias
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const a = await seedContact(org);
    await seedConversation(org, a, 90);
    const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };
    expect((await runSilenceSweep(deps)).enrolled).toBe(1);

    // desativar → publicar (fn_publish_followup_flow_version põe status='active')
    await pool.query(`update followup_flow_pointers set status = 'disabled' where id = $1`, [pointerId]);
    await pool.query(`update followup_flow_pointers set status = 'active' where id = $1`, [pointerId]);
    const b = await seedContact(org);
    await seedConversation(org, b, 90);
    await runSilenceSweep(deps);
    expect(await countEnrollments(pointerId, b)).toBe(0);
  });
});

// ---- 3e. episódio: a sequência não recomeça sozinha --------------------

async function seedInscricao(
  org: string,
  flow: { pointerId: string; versionId: string },
  contactId: string,
  status: "completed" | "dead" | "cancelled",
  startedAgoMinutes: number,
): Promise<void> {
  await pool.query(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, started_at,
        cancel_reason, completed_at)
     values ($1, $2, $3, $4, 't1', $5, null, now() - ($6 || ' minutes')::interval,
             case when $5 = 'cancelled' then 'atendimento_humano' end,
             case when $5 <> 'cancelled' then now() end)`,
    [org, flow.pointerId, flow.versionId, contactId, status, String(startedAgoMinutes)],
  );
}

describe("runSilenceSweep — episódio de silêncio: a sequência não recomeça", () => {
  for (const status of ["completed", "dead", "cancelled"] as const) {
    it(`inscrição ${status} no mesmo silêncio → não reinscreve em 3 varreduras`, async () => {
      const org = nextOrgId();
      await seedOrg(org);
      const flow = await seedSilenceFlow(org, { thresholdMinutes: 30 });
      await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [flow.pointerId] });
      const contactId = await seedContact(org);
      await seedConversation(org, contactId, 90); // calado há 90 min
      await seedInscricao(org, flow, contactId, status, 60); // começou depois da última entrada

      const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };
      for (let i = 0; i < 3; i++) {
        const s = await runSilenceSweep(deps);
        expect(s.enrolled).toBe(0);
        expect(s.skipped_same_episode).toBeGreaterThanOrEqual(1);
      }
      expect(await countEnrollments(flow.pointerId, contactId)).toBe(1);
    });
  }

  it("resposta depois da inscrição + novo silêncio → episódio novo, reinscreve", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flow = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [flow.pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 40); // respondeu há 40 min (calado > 30)
    await seedInscricao(org, flow, contactId, "completed", 60); // a anterior começou antes da resposta

    const s = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(s.enrolled).toBe(1);
    expect(await countEnrollments(flow.pointerId, contactId)).toBe(2);
  });

  it("laço real fechado ponta a ponta: inscreve, termina (End), e as varreduras seguintes não recomeçam", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flow = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [flow.pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const deps = { db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK };
    expect((await runSilenceSweep(deps)).enrolled).toBe(1);
    await pool.query(
      `update followup_enrollments set status = 'completed', completed_at = now(), next_eval_at = null, updated_at = now()
        where pointer_id = $1 and contact_id = $2`,
      [flow.pointerId, contactId],
    );
    await runSilenceSweep(deps);
    await runSilenceSweep(deps);
    expect(await countEnrollments(flow.pointerId, contactId)).toBe(1);
  });
});

// ---- 4. gate SQL integration (contra ai_agent_versions REAL) ------------

describe("isPointerEnabledForAutomaticTrigger — integração SQL real (ai_agent_versions)", () => {
  it("publicado + enabled=true + pointer no array → true", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "published", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(true);
  });

  it("versão em rascunho (status='draft', não publicada) → false mesmo com enabled=true", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "draft", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(false);
  });

  it("publicado mas followup.enabled=false → false", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await seedPublishedAgentVersion(org, { status: "published", enabled: false, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), org, pointerId)).resolves.toBe(false);
  });

  it("pointer habilitado numa org NÃO vaza pra outra org (cross-org)", async () => {
    const orgA = nextOrgId();
    const orgB = nextOrgId();
    await seedOrg(orgA);
    await seedOrg(orgB);
    const { pointerId } = await seedSilenceFlow(orgA);
    await seedPublishedAgentVersion(orgA, { status: "published", enabled: true, pointerIds: [pointerId] });

    await expect(isPointerEnabledForAutomaticTrigger(pgGateDb(), orgB, pointerId)).resolves.toBe(false);
  });
});

// ---- 6. Task 8.6: agent_id pinado no enrollment ------------------------

async function agentIdOfEnrollment(pointerId: string, contactId: string): Promise<string | null> {
  const { rows } = await pool.query<{ agent_id: string | null }>(
    `select agent_id from followup_enrollments where pointer_id = $1 and contact_id = $2`,
    [pointerId, contactId],
  );
  return rows[0]?.agent_id ?? null;
}

describe("runSilenceSweep — pina o agent_id do agente que arma o pointer (Task 8.6)", () => {
  it("um agente armando → agent_id do enrollment = esse agente", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const agentId = await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(summary.enrolled).toBe(1);
    expect(await agentIdOfEnrollment(pointerId, contactId)).toBe(agentId);
  });

  it(">1 agente armando o MESMO pointer → pina o MENOR agent_id (uuid asc, determinístico)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const AGENT_LOW = "a0000000-0000-4000-8000-000000000001";
    const AGENT_HIGH = "f0000000-0000-4000-8000-000000000001";
    // ordem de seed HIGH antes de LOW — o pick não pode depender da ordem de inserção
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId], agentId: AGENT_HIGH });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [pointerId], agentId: AGENT_LOW });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    expect(await agentIdOfEnrollment(pointerId, contactId)).toBe(AGENT_LOW);
  });
});

// ---- 7. Task 8.6: exclusividade 1-follow-up-vivo-por-lead ORG-WIDE ------

/**
 * Os status que ocupam a vaga do VIVO — copiados do baseline, nunca digitados
 * de memória. Três lugares deste arquivo dependem deles, e cada um por um
 * motivo diferente; o cabeçalho de `setOneLiveIndex` conta a história.
 */
const ONE_LIVE_STATUSES = "'active','waiting_reply','paused_handoff','paused_manual'";

/**
 * Quantos follow-ups VIVOS este contato tem.
 *
 * ⚠️ TERCEIRA CATEGORIA, e ela não é nenhuma das outras duas deste arquivo:
 * aqui não se restaura estado nem se reproduz história — faz-se uma PERGUNTA
 * sobre o estado atual. Por isso o predicado tem de ser o do produto HOJE, e
 * `paused_manual` entra: um enrollment pausado por uma pessoa ocupa a vaga do
 * vivo (é o que o índice garante desde a 0145), então uma contagem que o ignora
 * responde MENOS do que a realidade.
 *
 * Achado por `@QAVivo` na varredura do arquivo, e classificado por ele. Estava
 * LATENTE — medido: nenhuma asserção de hoje muda com a correção (16 verdes
 * antes, 16 depois). Consertado mesmo assim porque a armadilha estava armada: o
 * primeiro caso de pausa manual escrito aqui passaria por SORTE, que é
 * exatamente o defeito que esta wave já pagou uma vez.
 */
async function countLiveForContact(org: string, contactId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from followup_enrollments
     where organization_id = $1 and contact_id = $2
       and status in (${ONE_LIVE_STATUSES})`,
    [org, contactId],
  );
  return Number(rows[0]!.n);
}

const ONE_LIVE = "idx_followup_enrollments_one_live";

/**
 * ⚠️ O PREDICADO É COPIADO DO BASELINE, NÃO DIGITADO DE MEMÓRIA.
 *
 * Este helper dropa e recria um índice do schema no banco COMPARTILHADO pelos
 * invariantes — e o `finally` que "restaura o estado do baseline" restaurava uma
 * versão CONGELADA no tempo: `('active','waiting_reply','paused_handoff')`, de
 * antes de a 0145 acrescentar `paused_manual`. Depois que este arquivo rodava, o
 * banco ficava com um índice que o baseline não tem mais, e o próximo teste a
 * depender dele reprovava — determinística e rapidamente (27ms, falha de
 * asserção, não timeout), o que fez a suíte parecer instável por carga.
 *
 * Medido: rodando só `followup-silence-sweep` + `followup-intervencao`, o caso
 * "pausado ocupa a vaga do contato na ORGANIZAÇÃO" reprova; isolado, passa. É o
 * `IA360-FLAKY` com assinatura. Os papéis, porque a diferença ensina: `@QAVivo`
 * CARACTERIZOU o fenômeno (determinístico, 36ms, não timeout) e REFUTOU a
 * primeira atribuição — a de que o índice da 0145 explicava tudo, que não
 * sobrevivia ao "isolado passa". Refutar uma causa errada é barato e uma medição
 * basta; achar a certa custou seguir a pista dele ("o culpado está na
 * vizinhança") até o par de arquivos.
 *
 * A lição que a constante carrega: quem recria objeto de schema num banco
 * compartilhado assume a dívida de acompanhar TODA migration futura que o toque.
 */
async function setOneLiveIndex(columns: string): Promise<void> {
  await pool.query(`drop index if exists ${ONE_LIVE}`);
  await pool.query(
    `create unique index if not exists ${ONE_LIVE} on followup_enrollments (${columns})
       where status in (${ONE_LIVE_STATUSES})`,
  );
}

describe("runSilenceSweep — 1 follow-up vivo por lead ORG-WIDE (Task 8.6, furo do Rafael)", () => {
  it("RED→GREEN: contato silencioso casa 2 fluxos — índice ANTIGO (pointer,contact) enrolla nos DOIS (spam); o NOVO (org,contact) barra o 2º", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flowA = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const flowB = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    // um agente publicado arma AMBOS os pointers
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [flowA.pointerId, flowB.pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90); // silencioso p/ os dois

    // Este caso mede o ÍNDICE: o pré-filtro de inscrição viva da varredura fica
    // desligado aqui, senão ele mesmo pularia o 2º fluxo e o RED (o spam do
    // índice antigo) nunca apareceria. O índice é a garantia; o pré-filtro é
    // economia — e tem caso próprio logo abaixo.
    const deps = {
      db: { ...silenceSweepDb(), loadContatosComInscricaoViva: async () => new Set<string>() },
      gateDb: pgGateDb(),
      clock: CLOCK,
    };

    try {
      // RED — índice como era ANTES da 0062: (pointer_id, contact_id)
      await setOneLiveIndex("pointer_id, contact_id");
      const red = await runSilenceSweep(deps);
      expect(red.enrolled).toBe(2); // um por fluxo — o spam que o Rafael achou
      expect(await countLiveForContact(org, contactId)).toBe(2);

      // limpa (2 vivos violariam o índice único org-wide ao recriá-lo)
      await pool.query(`delete from followup_enrollments where contact_id = $1`, [contactId]);

      // GREEN — índice da 0062: (organization_id, contact_id)
      await setOneLiveIndex("organization_id, contact_id");
      const green = await runSilenceSweep(deps);
      expect(green.enrolled).toBe(1); // exclusividade: só o 1º fluxo enrolla
      expect(green.skipped_existing).toBeGreaterThanOrEqual(1); // o 2º barrado por 23505 org-wide
      expect(await countLiveForContact(org, contactId)).toBe(1);
    } finally {
      // restaura o estado do baseline (índice org-wide), sem deixar linha viva órfã
      await pool.query(`drop index if exists ${ONE_LIVE}`);
      await pool.query(`delete from followup_enrollments where contact_id = $1`, [contactId]);
      await setOneLiveIndex("organization_id, contact_id");
    }
  });

  it("com o pré-filtro, o 2º fluxo nem TENTA inscrever quem já está vivo (sem 23505 a cada minuto)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flowA = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const flowB = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    await seedPublishedAgentVersion(org, { enabled: true, pointerIds: [flowA.pointerId, flowB.pointerId] });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    const base = silenceSweepDb();
    const tentativas: string[] = [];
    const db: SilenceSweepDb = {
      ...base,
      insertEnrollment: async (input) => {
        if (input.contact_id === contactId) tentativas.push(input.pointer_id);
        return base.insertEnrollment(input);
      },
    };
    const deps = { db, gateDb: pgGateDb(), clock: CLOCK };

    const primeira = await runSilenceSweep(deps);
    expect(primeira.enrolled).toBe(1);
    expect(tentativas).toHaveLength(1); // o 2º fluxo leu "já vivo" e pulou sem tentar
    expect(primeira.skipped_existing).toBeGreaterThanOrEqual(1);

    // os ticks seguintes (1×/min em produção) também não tentam: era aqui que
    // nasciam os ~124 mil 23505 por dia
    await runSilenceSweep(deps);
    await runSilenceSweep(deps);
    expect(tentativas).toHaveLength(1);
    expect(await countLiveForContact(org, contactId)).toBe(1);
  });

  it("contato JÁ vivo no fluxo A → sweep do fluxo B NÃO enrolla (índice do baseline)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flowA = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const flowB = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const agentId = await seedPublishedAgentVersion(org, {
      enabled: true,
      pointerIds: [flowA.pointerId, flowB.pointerId],
    });
    const contactId = await seedContact(org);
    await seedConversation(org, contactId, 90);

    // enrollment vivo pré-existente no fluxo A (direto, como se um sweep anterior tivesse criado)
    await pool.query(
      `insert into followup_enrollments
         (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, agent_id)
       values ($1, $2, $3, $4, 't1', 'active', now(), $5)`,
      [org, flowA.pointerId, flowA.versionId, contactId, agentId],
    );

    const summary = await runSilenceSweep({ db: silenceSweepDb(), gateDb: pgGateDb(), clock: CLOCK });
    // fluxo B tentou, bateu no índice org-wide → skip, nada novo
    expect(await countEnrollments(flowB.pointerId, contactId)).toBe(0);
    expect(await countLiveForContact(org, contactId)).toBe(1);
    expect(summary.skipped_existing).toBeGreaterThanOrEqual(1);
  });
});

// ---- 8. Task 8.6: dedup da migration 0062 (antes do índice) -------------

describe("dedup 0062 — >1 enrollment vivo pro mesmo (org,contact) vira 1 vivo + resto cancelado", () => {
  it("mantém o started_at MAIS RECENTE; os demais → cancelled/exclusivity_backfill/next_eval_at null", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const flowA = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const flowB = await seedSilenceFlow(org, { thresholdMinutes: 30 });
    const contactId = await seedContact(org);

    try {
      // estado sujo pré-migration: 2 vivos pro mesmo (org,contact). Só é possível
      // sem o índice org-wide — reproduz um clone anterior à 0062.
      await pool.query(`drop index if exists ${ONE_LIVE}`);
      const older = await pool.query<{ id: string }>(
        `insert into followup_enrollments
           (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, started_at)
         values ($1,$2,$3,$4,'t1','active', now(), now() - interval '2 hours') returning id`,
        [org, flowA.pointerId, flowA.versionId, contactId],
      );
      const newer = await pool.query<{ id: string }>(
        `insert into followup_enrollments
           (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, started_at)
         values ($1,$2,$3,$4,'t1','active', now(), now() - interval '10 minutes') returning id`,
        [org, flowB.pointerId, flowB.versionId, contactId],
      );

      // A DEDUP exata da migration 0062 (window function genérica, sem ids hardcoded).
      //
      // ⚠️ ESTE PREDICADO NÃO ACOMPANHA A 0145, E É DE PROPÓSITO. Ele não
      // restaura estado: REPRODUZ o que a 0062 fazia, e a 0062 não conhecia
      // `paused_manual`. Acrescentar o status aqui mudaria o que a réplica
      // replica — o oposto de consertar. O predicado que PRECISA acompanhar as
      // migrations é o de `setOneLiveIndex`, lá em cima, porque aquele devolve o
      // banco compartilhado ao estado do baseline.
      await pool.query(
        `with ranked as (
           select id, row_number() over (
             partition by organization_id, contact_id
             order by started_at desc, id desc
           ) as rn
           from followup_enrollments
           where status in ('active','waiting_reply','paused_handoff')
         )
         update followup_enrollments e
         set status='cancelled', cancel_reason='exclusivity_backfill', next_eval_at=null, updated_at=now()
         from ranked where e.id = ranked.id and ranked.rn > 1`,
      );

      // recriar o índice único org-wide agora PASSA (dado curado antes)
      await setOneLiveIndex("organization_id, contact_id");

      expect(await countLiveForContact(org, contactId)).toBe(1);
      const kept = await pool.query<{ status: string }>(
        `select status from followup_enrollments where id = $1`,
        [newer.rows[0]!.id],
      );
      expect(kept.rows[0]!.status).toBe("active"); // o mais recente sobrevive
      const cancelled = await pool.query<{ status: string; cancel_reason: string; next_eval_at: string | null }>(
        `select status, cancel_reason, next_eval_at from followup_enrollments where id = $1`,
        [older.rows[0]!.id],
      );
      expect(cancelled.rows[0]!.status).toBe("cancelled");
      expect(cancelled.rows[0]!.cancel_reason).toBe("exclusivity_backfill");
      expect(cancelled.rows[0]!.next_eval_at).toBeNull();
    } finally {
      await pool.query(`drop index if exists ${ONE_LIVE}`);
      await pool.query(`delete from followup_enrollments where contact_id = $1`, [contactId]);
      await setOneLiveIndex("organization_id, contact_id");
    }
  });
});

// ---- 9. vigência do ponteiro (active_since, migration 0324) -------------

/**
 * `followup_flow_pointers.active_since`: desde quando o ponteiro vale com o
 * status e o gatilho (kind + segmentos) atuais. O trigger
 * `trg_followup_ponteiro_marca_vigencia` a avança SÓ quando muda o status, o
 * `kind` ou os `segments` — publicar versão nova num fluxo já ativo, mexer no
 * limiar ou no `cancel_on_reply`, salvar rascunho ou renomear não descartam os
 * episódios em andamento.
 */
describe("vigência do ponteiro (active_since)", () => {
  async function vigencia(pointerId: string): Promise<Date> {
    const { rows } = await pool.query<{ active_since: Date }>(
      `select active_since from followup_flow_pointers where id = $1`,
      [pointerId],
    );
    return rows[0]!.active_since;
  }
  /** Recua a vigência 1 dia mexendo SÓ nela — o WHEN do trigger não casa. */
  async function recuar(pointerId: string): Promise<Date> {
    await pool.query(`update followup_flow_pointers set active_since = now() - interval '1 day' where id = $1`, [
      pointerId,
    ]);
    const v = await vigencia(pointerId);
    expect(Date.now() - v.getTime()).toBeGreaterThan(23 * 3600_000); // o próprio recuo não disparou o trigger
    return v;
  }
  const avancou = (v: Date) => expect(Date.now() - v.getTime()).toBeLessThan(60_000);

  it("(a) ponteiro novo nasce com active_since ≈ now()", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { rows } = await pool.query<{ active_since: Date }>(
      `insert into followup_flow_pointers (organization_id, name, status, trigger_config)
       values ($1, $2, 'active', '{"kind":"silence","params":{"threshold_minutes":30}}') returning active_since`,
      [org, `vig-${Date.now()}-${Math.random()}`],
    );
    avancou(rows[0]!.active_since);
  });

  it("(b) versão nova num fluxo já ativo NÃO muda a vigência (publicar e rollback só trocam a versão)", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    const antes = await recuar(pointerId);
    const { rows } = await pool.query<{ id: string }>(
      `insert into followup_flow_versions (organization_id, graph) select organization_id, graph from followup_flow_versions
        where id = (select active_version_id from followup_flow_pointers where id = $1) returning id`,
      [pointerId],
    );
    await pool.query(`update followup_flow_pointers set active_version_id = $2 where id = $1`, [pointerId, rows[0]!.id]);
    expect(await vigencia(pointerId)).toEqual(antes);
  });

  it("(c) desativar e reativar avança a vigência nas duas vezes", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await recuar(pointerId);
    await pool.query(`update followup_flow_pointers set status = 'disabled' where id = $1`, [pointerId]);
    avancou(await vigencia(pointerId));
    await recuar(pointerId);
    await pool.query(`update followup_flow_pointers set status = 'active' where id = $1`, [pointerId]);
    avancou(await vigencia(pointerId));
  });

  it("(d) trocar o kind do gatilho, ou os segmentos, avança a vigência", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    await recuar(pointerId);
    await pool.query(`update followup_flow_pointers set trigger_config = '{"kind":"manual"}' where id = $1`, [pointerId]);
    avancou(await vigencia(pointerId));
    await pool.query(
      `update followup_flow_pointers set trigger_config = '{"kind":"silence","params":{"threshold_minutes":60}}' where id = $1`,
      [pointerId],
    );
    await recuar(pointerId);
    await pool.query(
      `update followup_flow_pointers
          set trigger_config = '{"kind":"silence","params":{"threshold_minutes":60,"segments":["vip"]}}' where id = $1`,
      [pointerId],
    );
    avancou(await vigencia(pointerId));
  });

  it("(e) rascunho, nome e handoff_policy NÃO mudam a vigência", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org);
    const antes = await recuar(pointerId);
    await pool.query(
      `update followup_flow_pointers
          set draft_graph = '{"nodes":[],"edges":[]}', name = name || ' (editado)', handoff_policy = 'cancel'
        where id = $1`,
      [pointerId],
    );
    expect(await vigencia(pointerId)).toEqual(antes);
  });

  it("(f) o mesmo gatilho, o limiar, o cancel_on_reply e segmentos [] ↔ ausentes NÃO mudam a vigência", async () => {
    const org = nextOrgId();
    await seedOrg(org);
    const { pointerId } = await seedSilenceFlow(org); // threshold 60, segments []
    const antes = await recuar(pointerId);
    await pool.query(`update followup_flow_pointers set trigger_config = trigger_config where id = $1`, [pointerId]);
    await pool.query(
      `update followup_flow_pointers
          set trigger_config = '{"kind":"silence","cancel_on_reply":true,"params":{"threshold_minutes":120}}' where id = $1`,
      [pointerId],
    );
    expect(await vigencia(pointerId)).toEqual(antes);
  });

  it("(g) o índice da consulta de episódio existe, idêntico ao 0411 do original", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'idx_followup_enrollments_pointer_contact_cooldown'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\(organization_id, pointer_id, contact_id, updated_at\)/);
  });

  it("(h) a função do trigger não é executável por anon nem por PUBLIC", async () => {
    const { rows } = await pool.query<{ anon: boolean; publico: boolean }>(
      `select has_function_privilege('anon', 'public.fn_followup_ponteiro_marca_vigencia()', 'execute') as anon,
              exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where p.oid = 'public.fn_followup_ponteiro_marca_vigencia()'::regprocedure
                         and a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico`,
    );
    expect(rows[0]).toEqual({ anon: false, publico: false });
  });
});
