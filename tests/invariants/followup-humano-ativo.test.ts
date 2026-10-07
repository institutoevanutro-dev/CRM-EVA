/**
 * Humano ativo como fato da decisão de envio do follow-up — a CONSULTA real
 * (`lerFatosDoEnvio`) contra o baseline.
 *
 * O que se prova: "uma pessoa da equipe respondeu" é uma saída humana
 * (`sent_via` `user`/`external_device`) DEPOIS do maior marco entre a última
 * mensagem recebida da conversa, a última retomada da inscrição e o início
 * dela; o eco do nosso próprio envio não conta; e nada vaza entre organizações
 * nem entre conversas do mesmo contato.
 */
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { conferirAntesDoEnvio, lerFatosDoEnvio } from "@/lib/followup/bloqueios-obrigatorios";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { isolarFixtureDeFollowup } from "./followup-isolamento";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await isolarFixtureDeFollowup(pool);
});

const T0 = new Date("2026-09-20T12:00:00.000Z"); // início da inscrição
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const seg = (n: number) => new Date(T0.getTime() + n * 1_000);

async function novaOrg(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into organizations (slug, legal_name, display_name)
     values ('humano-ativo-' || substr(gen_random_uuid()::text, 1, 12), 'Humano Ativo', 'Humano Ativo') returning id`,
  );
  return rows[0]!.id;
}

interface Cenario {
  org: string;
  contactId: string;
  conversationId: string;
  channelSessionId: string;
  enrollmentId: string;
}

async function montar(
  opts: { handoffPolicy?: "pause" | "cancel" | "allow"; gatilho?: Record<string, unknown> } = {},
): Promise<Cenario> {
  const org = await novaOrg();
  const { rows: c } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Contato Humano Ativo') returning id`,
    [org],
  );
  const contactId = c[0]!.id;
  const boundary = await criarOrigemDeFollowup(pool, org, contactId);
  const conversationId = boundary.conversation_id!;
  const { rows: v } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, '{"nodes":[],"edges":[]}'::jsonb) returning id`,
    [org],
  );
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config, handoff_policy)
     values ($1, 'Fluxo ' || gen_random_uuid()::text, 'active', $2, $4::jsonb, $3) returning id`,
    [org, v[0]!.id, opts.handoffPolicy ?? "pause", JSON.stringify(opts.gatilho ?? { kind: "manual" })],
  );
  const { rows: e } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, conversation_id, service_boundary, started_at)
     values ($1, $2, $3, $4, 'a1', 'active', now() + interval '1 hour', $5, $6::jsonb, $7)
     returning id`,
    [org, p[0]!.id, v[0]!.id, contactId, conversationId, JSON.stringify(boundary), T0.toISOString()],
  );
  const { rows: s } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [conversationId],
  );
  return { org, contactId, conversationId, channelSessionId: s[0]!.channel_session_id, enrollmentId: e[0]!.id };
}

async function mensagem(
  c: Cenario,
  m: {
    direction: "inbound" | "outbound";
    sentVia?: string;
    em: Date;
    externalId?: string;
    organizationId?: string;
    conversationId?: string;
  },
): Promise<void> {
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, body, external_id, created_at, sent_at)
     values ($1, $2, $3, $4, 'text', $5, $6, $7, 'oi', $8, $9, $9)`,
    [
      m.organizationId ?? c.org,
      m.conversationId ?? c.conversationId,
      c.channelSessionId,
      c.contactId,
      m.direction,
      m.direction === "inbound" ? "received" : "sent",
      m.sentVia ?? (m.direction === "inbound" ? "crm" : "ai"),
      m.externalId ?? null,
      m.em.toISOString(),
    ],
  );
}

async function fatos(c: Cenario) {
  const leitura = await lerFatosDoEnvio(pool, {
    organizationId: c.org,
    contactId: c.contactId,
    conversationId: c.conversationId,
    enrollmentId: c.enrollmentId,
  });
  expect(leitura.ok).toBe(true);
  if (!leitura.ok) throw new Error("leitura falhou");
  return leitura.fatos;
}

describe("humano_respondeu — a consulta real", () => {
  it("celular (external_device) depois do inbound → true", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "external_device", em: min(12) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("composer (user) depois do inbound → true", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(12) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("IA (ai) depois do inbound → false (controle)", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "ai", em: min(12) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("humano antes do inbound → false", async () => {
    const c = await montar();
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(5) });
    await mensagem(c, { direction: "inbound", em: min(10) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("humano depois do inbound mas ANTES do início da inscrição → false (fluxo que cobra depois da proposta)", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(-30) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(-10) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("gatilho de SILÊNCIO: humano entre o inbound e o início da inscrição → true (é quem está atendendo)", async () => {
    // A inscrição de silêncio nasce DEPOIS do inbound a que reage (threshold);
    // uma resposta humana nesse meio é exatamente o atendimento em curso.
    const c = await montar({ gatilho: { kind: "silence", params: { threshold_minutes: 30 } } });
    await mensagem(c, { direction: "inbound", em: min(-30) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(-10) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("etapa → mensagem humana → passo: a proposta mandada DEPOIS de mover a etapa não encerra a cobrança → false", async () => {
    // A ordem comum do funil: o vendedor move para "Proposta enviada" (a
    // inscrição nasce) e só então manda a proposta. Ninguém respondeu a nada
    // desta inscrição ainda.
    const c = await montar({ gatilho: { kind: "stage_change", params: { stage_id: "00000000-0000-4000-8000-000000000001" } } });
    await mensagem(c, { direction: "inbound", em: min(-60) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: seg(30) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("depois que o fluxo enviou um passo, a mensagem humana volta a contar → true", async () => {
    const c = await montar({ gatilho: { kind: "stage_change", params: { stage_id: "00000000-0000-4000-8000-000000000001" } } });
    await mensagem(c, { direction: "inbound", em: min(-60) });
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at)
       values ($1, $2, 'a1', 'action_sent', '{}'::jsonb, 'passo-' || gen_random_uuid()::text, $3)`,
      [c.org, c.enrollmentId, min(5).toISOString()],
    );
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(6) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("resposta automática do WhatsApp Business (celular a 3 s do inbound) → false", async () => {
    // Saudação/ausência do app do celular: sincroniza como fromMe e entra como
    // external_device logo depois do inbound que a disparou.
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "external_device", em: new Date(min(10).getTime() + 3_000) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
    // O composer não tem resposta automática: a 3 s do inbound, ainda é uma pessoa.
    await mensagem(c, { direction: "outbound", sentVia: "user", em: new Date(min(10).getTime() + 3_000) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("humano antes da retomada (handoff_resumed) → false", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(12) });
    await pool.query(
      `insert into followup_enrollment_events (organization_id, enrollment_id, node_id, event_type, payload, idempotency_key, created_at)
       values ($1, $2, 'a1', 'handoff_resumed', '{}'::jsonb, 'retomada-' || gen_random_uuid()::text, $3)`,
      [c.org, c.enrollmentId, min(20).toISOString()],
    );
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
    // E o humano que fala DEPOIS da retomada volta a contar.
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(25) });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(true);
  });

  it("eco não removido do nosso envio (external_device com o mesmo id) → false", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "ai", em: min(12), externalId: "3EB0ECO123" });
    await mensagem(c, {
      direction: "outbound",
      sentVia: "external_device",
      em: min(12),
      externalId: "true_5511999998888@c.us_3EB0ECO123",
    });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("humano em OUTRA conversa do mesmo contato → false", async () => {
    const c = await montar();
    await mensagem(c, { direction: "inbound", em: min(10) });
    const { rows: sessao } = await pool.query<{ id: string }>(
      `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, gen_random_uuid()::text, 'WORKING', decode('00', 'hex')) returning id`,
      [c.org],
    );
    const { rows } = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, status)
       values ($1, $2, $3, 'open') returning id`,
      [c.org, c.contactId, sessao[0]!.id],
    );
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(12), conversationId: rows[0]!.id });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });

  it("linha de OUTRA organização apontando para esta conversa não vaza → false", async () => {
    // A FK de conversation_id é de coluna única: nada impede uma linha com a
    // organização B e a conversa de A. É a única forma de o filtro por
    // organization_id fazer diferença sobre o filtro por conversa.
    const c = await montar();
    const orgB = await novaOrg();
    await mensagem(c, { direction: "inbound", em: min(10) });
    await mensagem(c, { direction: "outbound", sentVia: "user", em: min(12), organizationId: orgB });
    expect((await fatos(c)).conversa.humano_respondeu).toBe(false);
  });
});

describe("atribuida_a_pessoa e handoff_policy", () => {
  it("conversa atribuída a uma pessoa → true; política do pointer lida", async () => {
    const c = await montar({ handoffPolicy: "allow" });
    expect((await fatos(c)).conversa.atribuida_a_pessoa).toBe(false);
    const { rows: u } = await pool.query<{ id: string }>(`select id from auth.users limit 1`);
    let userId = u[0]?.id;
    if (!userId) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), 'humano-ativo-' || gen_random_uuid()::text || '@teste.local') returning id`,
      );
      userId = rows[0]!.id;
    }
    await pool.query(
      `update conversations set assignee_kind = 'user', assigned_to_user_id = $3 where organization_id = $1 and id = $2`,
      [c.org, c.conversationId, userId],
    );
    const f = await fatos(c);
    expect(f.conversa.atribuida_a_pessoa).toBe(true);
    expect(f.handoff_policy).toBe("allow");
  });
});

describe("a mesma decisão para o atalho e o worker — conferirAntesDoEnvio contra o banco", () => {
  const conferir = (c: Cenario) =>
    conferirAntesDoEnvio(
      pool,
      { organizationId: c.org, contactId: c.contactId, conversationId: c.conversationId, enrollmentId: c.enrollmentId },
      new Date(),
    );

  async function atribuirAUmaPessoa(c: Cenario): Promise<void> {
    const { rows: u } = await pool.query<{ id: string }>(`select id from auth.users limit 1`);
    let userId = u[0]?.id;
    if (!userId) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), 'humano-ativo-' || gen_random_uuid()::text || '@teste.local') returning id`,
      );
      userId = rows[0]!.id;
    }
    await pool.query(
      `update conversations set assignee_kind = 'user', assigned_to_user_id = $3 where organization_id = $1 and id = $2`,
      [c.org, c.conversationId, userId],
    );
  }

  it("'Permitir durante handoff' com conversa atribuída a uma pessoa → envia (nos dois caminhos)", async () => {
    const c = await montar({ handoffPolicy: "allow" });
    await atribuirAUmaPessoa(c);
    expect(await conferir(c)).toEqual({ envia: true });
  });

  it("'pause' com conversa atribuída a uma pessoa → encerra com atendimento humano (controle)", async () => {
    const c = await montar({ handoffPolicy: "pause" });
    await atribuirAUmaPessoa(c);
    expect(await conferir(c)).toEqual({ envia: false, motivo: "atendimento_humano", invalida: true });
  });

  it("número em allowlist e contato sem autorização → encerra com 'conversa_nao_liberada'; autorizado → envia", async () => {
    const c = await montar();
    await pool.query(
      `update channel_sessions set metadata = coalesce(metadata, '{}'::jsonb) || '{"ai_gate":"allowlist"}'::jsonb
        where organization_id = $1 and id = $2`,
      [c.org, c.channelSessionId],
    );
    const f = await fatos(c);
    expect(f.liberacao.ai_gate).toBe("allowlist");
    expect(f.liberacao.ai_autorizado_em).toBeNull();
    expect(await conferir(c)).toEqual({ envia: false, motivo: "conversa_nao_liberada", invalida: true });

    await pool.query(`update contacts set ai_authorized_at = now() where organization_id = $1 and id = $2`, [c.org, c.contactId]);
    expect(await conferir(c)).toEqual({ envia: true });
  });
});
