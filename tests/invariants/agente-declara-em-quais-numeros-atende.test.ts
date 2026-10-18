import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { resolveConversationTurn } from "@/lib/agent-engine/agent/resolve-turn-agent";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { createLogger } from "@/lib/agent-engine/obs/logger";

/**
 * CADA AGENTE DECLARA EM QUAIS NÚMEROS ATENDE (migration 0380).
 *
 * A declaração é uma lista de PERMISSÃO por agente em
 * `ai_agent_channel_sessions`: nenhuma linha = todos os números (o padrão, e é
 * por isso que nada muda para agente existente); com linhas, só nos listados.
 * Medido contra o schema real, nas quatro portas por onde um agente fala:
 *
 *   1. o portão de custo do `drain` (abre ou não o turno do número);
 *   2. o agente PUBLICADO no número (`loadPublishedAgentConfig`);
 *   3. o roteador do número (membros e fallback, `loadActiveRouter`);
 *   4. o turno: quando a declaração tirou do número todo agente que o
 *      atenderia, o turno NÃO cai no agente genérico (`numero_recusado`).
 *
 * Mais as cercas da tabela: RLS por organização com escrita só de admin, FK
 * composta que recusa número de outra organização, e apagar número citado
 * recusado (sumir a última linha abriria o agente para todos os números).
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2854 de @webtecnica).
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const log = createLogger();

const ORG = "03800000-0000-4000-8000-000000000001";
const OUTRA_ORG = "03800000-0000-4000-8000-000000000002";
const CONTATO = "03800000-0000-4000-8000-000000000003";
const ADMIN = "03800000-1111-4000-8000-000000000001";
const GERENTE = "03800000-1111-4000-8000-000000000002";
const ATENDENTE = "03800000-1111-4000-8000-000000000003";
const VIZINHO = "03800000-1111-4000-8000-000000000004";

const DRAIN_KNOBS = { batchSize: 20, intervalMs: 100, idleIntervalMs: 100, debounceMs: 0, reapTimeoutMs: 300_000 };

let seq = 0;
function proximoId(): string {
  seq += 1;
  return `03800000-9999-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface Cenario {
  session: string;
  conv: string;
  msg: string;
}

async function numero(org: string, nome: string): Promise<string> {
  const id = proximoId();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [id, org, `n0380-${nome}`],
  );
  return id;
}

/** Um número com uma conversa e uma mensagem recebida, pronto para o drain. */
async function cenario(nome: string): Promise<Cenario> {
  const session = await numero(ORG, nome);
  const conv = proximoId();
  const msg = proximoId();
  const contato = proximoId();
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Paciente Ficticio', $3)`,
    [contato, ORG, `+55119${String(seq).padStart(8, "0")}`],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false)`,
    [conv, ORG, contato, session],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())`,
    [msg, ORG, conv, session, contato],
  );
  return { session, conv, msg };
}

async function agente(sessionId: string, nome: string, prioridade = 0): Promise<string> {
  const agent = proximoId();
  const version = proximoId();
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind, priority)
     values ($1, $2, $3, 'você é um atendente', 'mcp_agent', $4)`,
    [agent, ORG, `Agente 0380 ${nome}`, prioridade],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at)
     values ($1, $2, $3, 1, 'você é um atendente', 'anthropic', 'claude-sonnet-4-6', $4, 'published', now())`,
    [version, ORG, agent, sessionId],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [version, agent]);
  return agent;
}

async function declarar(agentId: string, ...sessoes: string[]): Promise<void> {
  for (const s of sessoes) {
    await pool.query(
      `insert into ai_agent_channel_sessions (organization_id, agent_id, channel_session_id) values ($1, $2, $3)`,
      [ORG, agentId, s],
    );
  }
}

async function roteador(sessionId: string, opts: { fallback?: string; membro?: string }): Promise<string> {
  const id = proximoId();
  await pool.query(
    `insert into ai_routers (id, organization_id, name, channel_session_id, is_active, fallback_agent_id)
     values ($1, $2, 'Roteador 0380', $3, true, $4)`,
    [id, ORG, sessionId, opts.fallback ?? null],
  );
  if (opts.membro) {
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, 'agenda', 'marcar consulta')`,
      [ORG, id, opts.membro],
    );
  }
  return id;
}

async function atende(agentId: string, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    "select public.fn_agente_atende_no_numero($1, $2, $3) as ok",
    [ORG, agentId, sessionId],
  );
  return rows[0]!.ok;
}

async function drenaEGeraJob(c: Cenario): Promise<boolean> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, status)
     select $1::uuid, 'ai_agent.dispatch_requested', 'message', $2::uuid,
            jsonb_build_object('organization_id', $1::text, 'conversation_id', $3::text,
                               'contact_id', c.contact_id::text, 'channel_session_id', $4::text,
                               'inbound_message_id', $2::text),
            'pending'
       from conversations c where c.id = $3::uuid
     returning id`,
    [ORG, c.msg, c.conv, c.session],
  );
  const eventId = rows[0]!.id;
  await drainTick(pool, DRAIN_KNOBS, log);
  const { rows: jobs } = await pool.query<{ n: number }>(
    "select count(*)::int as n from job_queue where source_event_id = $1",
    [eventId],
  );
  return jobs[0]!.n > 0;
}

async function turno(c: Cenario) {
  const { rows } = await pool.query<{ contact_id: string }>("select contact_id from conversations where id = $1", [c.conv]);
  return resolveConversationTurn(
    pool,
    {} as never,
    {
      tenantId: ORG,
      leadId: rows[0]!.contact_id,
      jobId: proximoId(),
      conversationId: c.conv,
      channelSessionId: c.session,
      inbound: true,
    },
    { log },
  );
}

/** Escrita como `authenticated`, devolvendo quantas linhas o comando alcançou (0 = barrado). */
async function escreveComo(userId: string, dml: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, aal: "aal1" })]);
    const r = await client.query(dml);
    await client.query("rollback");
    return r.rowCount ?? 0;
  } catch {
    await client.query("rollback").catch(() => undefined);
    return 0;
  } finally {
    client.release();
  }
}

async function leComo(userId: string, select: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, aal: "aal1" })]);
    const r = await client.query<{ n: number }>(select);
    await client.query("rollback");
    return r.rows[0]!.n;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values
       ($1, 'org-0380', 'Clinica Ficticia 0380', 'Clinica 0380'),
       ($2, 'org-0380-vizinha', 'Vizinha Ficticia 0380', 'Vizinha 0380')
     on conflict (id) do nothing`,
    [ORG, OUTRA_ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1, $2, 'Paciente Base', '+5511900000380')
     on conflict (id) do nothing`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into auth.users (id, email) values
       ($1, 'admin-0380@invariant.test'), ($2, 'gerente-0380@invariant.test'),
       ($3, 'atendente-0380@invariant.test'), ($4, 'vizinho-0380@invariant.test')
     on conflict do nothing`,
    [ADMIN, GERENTE, ATENDENTE, VIZINHO],
  );
  await pool.query(
    `insert into user_organizations (user_id, organization_id, role, accepted_at) values
       ($1, $5, 'admin', now()), ($2, $5, 'manager', now()), ($3, $5, 'agent', now()), ($4, $6, 'admin', now())
     on conflict do nothing`,
    [ADMIN, GERENTE, ATENDENTE, VIZINHO, ORG, OUTRA_ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("a régua: nenhuma linha = todos os números", () => {
  it("sem declaração o agente atende em qualquer número; com declaração, só nos listados", async () => {
    const n1 = await numero(ORG, "regra-1");
    const n2 = await numero(ORG, "regra-2");
    const a = await agente(n1, "regra");
    expect(await atende(a, n1)).toBe(true);
    expect(await atende(a, n2)).toBe(true);
    await declarar(a, n1);
    expect(await atende(a, n1)).toBe(true);
    expect(await atende(a, n2)).toBe(false);
  });
});

describe("1 · o portão de custo do drain", () => {
  it("CONTROLE: agente publicado no número, sem declaração — o turno é enfileirado", async () => {
    const c = await cenario("portao-controle");
    await agente(c.session, "portao-controle");
    expect(await drenaEGeraJob(c)).toBe(true);
  });

  it("o agente publicado no número declarou OUTRO número: nada é enfileirado", async () => {
    const c = await cenario("portao-fechado");
    const outro = await numero(ORG, "portao-outro");
    const a = await agente(c.session, "portao-fechado");
    await declarar(a, outro);
    expect(await drenaEGeraJob(c)).toBe(false);
  });

  it("declarou ESTE número: o turno é enfileirado", async () => {
    const c = await cenario("portao-aberto");
    const outro = await numero(ORG, "portao-aberto-outro");
    const a = await agente(c.session, "portao-aberto");
    await declarar(a, outro, c.session);
    expect(await drenaEGeraJob(c)).toBe(true);
  });

  it("roteador cujo único membro declarou outro número: nada é enfileirado", async () => {
    const c = await cenario("portao-roteador");
    const outro = await numero(ORG, "portao-roteador-outro");
    const membro = await agente(outro, "portao-roteador-membro");
    await declarar(membro, outro);
    await roteador(c.session, { membro });
    expect(await drenaEGeraJob(c)).toBe(false);
  });
});

describe("2 · o agente publicado no número", () => {
  it("o de prioridade maior que declarou outro número cede a vez ao que atende aqui", async () => {
    const n = await numero(ORG, "publicado");
    const outro = await numero(ORG, "publicado-outro");
    const alto = await agente(n, "publicado-alto", 10);
    const baixo = await agente(n, "publicado-baixo", 0);
    expect((await loadPublishedAgentConfig(pool, ORG, n))?.agentId, "controle: sem declaração vence a prioridade").toBe(alto);
    await declarar(alto, outro);
    expect((await loadPublishedAgentConfig(pool, ORG, n))?.agentId).toBe(baixo);
  });
});

describe("3 · o roteador do número", () => {
  it("membro e fallback que declararam outro número saem do roteador; os que atendem aqui ficam", async () => {
    const n = await numero(ORG, "roteador");
    const outro = await numero(ORG, "roteador-outro");
    const fica = await agente(n, "roteador-fica");
    const sai = await agente(outro, "roteador-sai");
    const fallback = await agente(outro, "roteador-fallback");
    const r = await roteador(n, { fallback, membro: fica });
    await pool.query(
      `insert into ai_router_members (organization_id, router_id, agent_id, intent_name, intent_description)
       values ($1, $2, $3, 'financeiro', 'pagamento')`,
      [ORG, r, sai],
    );

    const antes = await loadActiveRouter(pool, ORG, n);
    expect(antes?.members.map((m) => m.agentId).sort(), "controle: sem declaração os dois membros").toEqual([fica, sai].sort());
    expect(antes?.fallbackAgentId).toBe(fallback);

    await declarar(sai, outro);
    await declarar(fallback, outro);
    const depois = await loadActiveRouter(pool, ORG, n);
    expect(depois?.members.map((m) => m.agentId)).toEqual([fica]);
    expect(depois?.fallbackAgentId).toBeNull();
  });
});

describe("4 · o turno não cai no agente genérico quando a declaração fechou o número", () => {
  it("CONTROLE: sem declaração, o turno resolve o agente do número", async () => {
    const c = await cenario("turno-controle");
    const a = await agente(c.session, "turno-controle");
    const r = await turno(c);
    expect(r.config?.agentId).toBe(a);
  });

  it("o único agente do número declarou outro: `numero_recusado`, sem config", async () => {
    const c = await cenario("turno-fechado");
    const outro = await numero(ORG, "turno-fechado-outro");
    const a = await agente(c.session, "turno-fechado");
    await declarar(a, outro);
    const r = await turno(c);
    expect(r.config).toBeNull();
    expect(r.outcome).toBe("numero_recusado");
  });

  it("número sem agente nenhum continua como era (não é a declaração que o calou)", async () => {
    const c = await cenario("turno-vazio");
    const r = await turno(c);
    expect(r.config).toBeNull();
    expect(r.outcome).not.toBe("numero_recusado");
  });
});

describe("as cercas da tabela", () => {
  it("admin declara; gerente e atendente são barrados; quem é da organização lê; o vizinho não", async () => {
    const n = await numero(ORG, "rls");
    const a = await agente(n, "rls");
    const insert = `insert into ai_agent_channel_sessions (organization_id, agent_id, channel_session_id)
                    values ('${ORG}', '${a}', '${n}')`;
    // A escrita da rota passa pelo service role; direto pelo PostgREST,
    // `authenticated` só tem SELECT — e a policy de escrita exige admin.
    expect(await escreveComo(GERENTE, insert)).toBe(0);
    expect(await escreveComo(ATENDENTE, insert)).toBe(0);
    await declarar(a, n);
    const contar = `select count(*)::int as n from ai_agent_channel_sessions where agent_id = '${a}'`;
    expect(await leComo(ATENDENTE, contar)).toBe(1);
    expect(await leComo(VIZINHO, contar)).toBe(0);
  });

  it("número de OUTRA organização é recusado pela FK composta", async () => {
    const n = await numero(ORG, "fk");
    const daVizinha = proximoId();
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, 'n0380-vizinha', 'WORKING', '\\x00'::bytea)`,
      [daVizinha, OUTRA_ORG],
    );
    const a = await agente(n, "fk");
    await expect(declarar(a, daVizinha)).rejects.toThrow(/ai_agent_channel_sessions_channel_org_fk/);
  });

  it("apagar um número citado na declaração é recusado (a última linha some → o agente abriria para todos)", async () => {
    const n = await numero(ORG, "apagar");
    const citado = await numero(ORG, "apagar-citado");
    const a = await agente(n, "apagar");
    await declarar(a, citado);
    await expect(pool.query("delete from channel_sessions where id = $1", [citado])).rejects.toThrow(
      /ai_agent_channel_sessions_channel_org_fk/,
    );
  });

  it("só o service role executa a régua (as duas origens de EXECUTE revogadas)", async () => {
    const { rows } = await pool.query<{ r: string | null }>(
      `select string_agg(r, ',' order by r) as r from unnest(array['anon','authenticated','service_role']) r
        where has_function_privilege(r, 'public.fn_agente_atende_no_numero(uuid, uuid, uuid)', 'execute')`,
    );
    expect(rows[0]!.r).toBe("service_role");
  });
});
