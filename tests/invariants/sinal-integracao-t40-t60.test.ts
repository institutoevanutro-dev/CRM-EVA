/**
 * Prova, contra Postgres real, a cadeia completa pedida antes do deploy da
 * Spec 20 (bloqueio do sinal, migration 0266):
 *
 *   reserva real → inscrição vinculada (appointment_id) → T+40 (envia) →
 *   T+60 (bloqueios param o lembrete) → aviso interno de revisão (Central).
 *
 * Também prova, no mesmo cenário de dados reais, os dois detalhes que só
 * tinham teste com fatos sintéticos em `bloqueios-obrigatorios.test.ts` /
 * `revisao-do-sinal.test.ts`: o comprovante bloqueia o lembrete ANTES de o
 * card mover, e a revisão de T+60 não duplica em reentrega (idempotência por
 * `ref_kind='calendar_appointment'` + `ref_id`).
 *
 * ═══ O QUE É PRODUÇÃO E O QUE É ADAPTADOR DE TESTE ═══
 *
 * `lerFatosDoEnvio` e `decidirEnvio` (bloqueios-obrigatorios.ts) são chamados
 * DIRETAMENTE — já recebem `pg.Pool`, sem adaptação. `acionarSupervisao`
 * também (arquivo irmão). Já os helpers de leitura da revisão humana
 * (`listarReservasVencidas`, `etapaJaTrataOSinal`, `jaTemItemAberto`,
 * `abrirItemDeRevisao`, em revisao-do-sinal.ts) usam `SupabaseClient`
 * (`.from()`), que não existe neste harness — só Postgres puro (sem
 * PostgREST). Por isso o bloco de revisão AQUI replica a MESMA SQL desses
 * helpers em `pg.Pool` puro (mesmo padrão de `reactivityDb()` em
 * followup-reactivity.test.ts), e usa a função pura `decidirRevisaoHumana`
 * — essa sim importada direto da produção, sem cópia.
 */
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_SEM_BLOQUEIOS_OPCIONAIS,
  decidirEnvio,
  lerFatosDoEnvio,
  type ConfigDosBloqueios,
} from "@/lib/followup/bloqueios-obrigatorios";
import { decidirRevisaoHumana, type FatosDaRevisao } from "@/lib/followup/revisao-do-sinal";
import type { FlowGraph } from "@/lib/followup/graph-schema";

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

// ---- seeds ----

let orgSeq = 0;

// UUID v4-like determinístico e legível: 8-4-4-4-12 hex, formato exato que a
// coluna `uuid` exige. `prefixoHex` (4 hex chars) distingue o cenário a olho
// nu num `select * from organizations`; `seq` evita colisão entre `it`s.
function idDeTeste(prefixoHex: string, seq: number): string {
  const s = seq.toString(16).padStart(4, "0");
  return `${prefixoHex}0000-0000-4000-8000-${s}00000001`;
}

async function seedOrg(org: string, settings?: unknown): Promise<void> {
  const name = `sinal-t40-t60-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, $3, $4, coalesce($5::jsonb, '{}'::jsonb))
     on conflict (id) do update set settings = excluded.settings`,
    [org, name, name, name, settings ? JSON.stringify(settings) : null],
  );
}

async function seedContact(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, is_blocked) values ($1, 'Contato do Sinal', false) returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedEventType(org: string, requiresSignal: boolean): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_event_types (organization_id, name, slug, requires_signal)
     values ($1, 'Consulta', 'consulta-' || substr(gen_random_uuid()::text, 1, 8), $2)
     returning id`,
    [org, requiresSignal],
  );
  return rows[0]!.id;
}

/**
 * `criadaEm` é escrita por UPDATE depois do insert: a coluna tem
 * `default now()`, e é exatamente o instante que este teste precisa
 * controlar para simular T+40 e T+60 sem esperar o relógio de verdade.
 */
async function seedReserva(params: {
  org: string;
  contactId: string;
  eventTypeId: string;
  criadaEm: Date;
  consultaEm: Date;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into calendar_appointments (organization_id, event_type_id, title, starts_at, ends_at, contact_id, created_at)
     values ($1, $2, 'Consulta com sinal', $3, $3 + interval '30 minutes', $4, $3)
     returning id`,
    [params.org, params.eventTypeId, params.consultaEm.toISOString(), params.contactId],
  );
  const id = rows[0]!.id;
  await pool.query(`update calendar_appointments set created_at = $2 where id = $1`, [id, params.criadaEm.toISOString()]);
  return id;
}

const SIMPLE_GRAPH: FlowGraph = {
  nodes: [
    { id: "w1", type: "wait", label: "Wait", position: { x: 0, y: 0 }, config: { mode: "fixed", duration_ms: 600_000 } },
    { id: "e1", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [{ id: "w1-e1", source: "w1", target: "e1", priority: 0, condition: { type: "always" } }],
};

async function seedFluxoDoSinal(org: string): Promise<{ pointerId: string; versionId: string }> {
  const { rows: versionRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(SIMPLE_GRAPH)],
  );
  const versionId = versionRows[0]!.id;
  // cancel_on_reply:true — sem isto o comprovante não bloquearia nada
  // sozinho (ver docs/specs/20-spec-supervisao-de-agente.md, seção da T+60).
  const { rows: pointerRows } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id, trigger_config)
     values ($1, $2, 'active', $3, $4) returning id`,
    [org, `Cobrança de sinal ${Date.now()}-${Math.random()}`, versionId, JSON.stringify({ kind: "manual", cancel_on_reply: true })],
  );
  return { pointerId: pointerRows[0]!.id, versionId };
}

async function seedInscricaoDoSinal(params: {
  org: string;
  pointerId: string;
  versionId: string;
  contactId: string;
  appointmentId: string;
  startedAt: Date;
}): Promise<string> {
  const boundary = await criarOrigemDeFollowup(pool, params.org, params.contactId);
  const { rows } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, conversation_id, service_boundary, appointment_id, started_at)
     values ($1, $2, $3, $4, 'w1', 'active', now() + interval '1 hour', $5, $6::jsonb, $7, $8)
     returning id`,
    [
      params.org,
      params.pointerId,
      params.versionId,
      params.contactId,
      boundary.conversation_id,
      JSON.stringify(boundary),
      params.appointmentId,
      params.startedAt.toISOString(),
    ],
  );
  return rows[0]!.id;
}

async function seedPipelineEStage(org: string, blocksFollowups: boolean): Promise<{ pipelineId: string; stageId: string }> {
  const { rows: p } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil do Sinal', 'funil-sinal-' || substr(gen_random_uuid()::text, 1, 8)) returning id`,
    [org],
  );
  const pipelineId = p[0]!.id;
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position, blocks_followups)
     values ($1, $2, 'Aguardando sinal', 'aguardando-sinal-' || substr(gen_random_uuid()::text, 1, 8), 100, $3)
     returning id`,
    [org, pipelineId, blocksFollowups],
  );
  return { pipelineId, stageId: s[0]!.id };
}

async function seedLead(org: string, contactId: string, pipelineId: string, stageId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_leads (organization_id, pipeline_id, stage_id, contact_id, title)
     values ($1, $2, $3, $4, 'Lead do sinal') returning id`,
    [org, pipelineId, stageId, contactId],
  );
  return rows[0]!.id;
}

async function inserirInbound(org: string, contactId: string, conversationId: string, quando: Date): Promise<void> {
  const { rows: sess } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [conversationId],
  );
  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body, created_at, sent_at)
     values ($1, $2, $3, $4, 'text', 'inbound', 'aqui está meu comprovante', $5, $5)`,
    [org, conversationId, sess[0]!.channel_session_id, contactId, quando.toISOString()],
  );
}

// ---- réplica em pg puro dos helpers de revisao-do-sinal.ts (ver cabeçalho) ----

async function etapaJaTrataOSinalPg(org: string, contactId: string): Promise<boolean> {
  const { rows } = await pool.query<{ blocks: boolean }>(
    `select coalesce(s.blocks_followups, false) as blocks
       from crm_leads l join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
      where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'`,
    [org, contactId],
  );
  return rows.some((r) => r.blocks === true);
}

async function jaTemItemAbertoPg(org: string, appointmentId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_inbox_items
      where organization_id = $1 and ref_kind = 'calendar_appointment' and ref_id = $2 and status = 'open'`,
    [org, appointmentId],
  );
  return Number(rows[0]!.n) > 0;
}

async function abrirItemDeRevisaoPg(org: string, appointmentId: string): Promise<void> {
  await pool.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     values ($1, 'sinal_revisao_humana', 'warn', 'Sinal não confirmado — revisão humana',
             'A reserva passou do prazo sem comprovante tratado. Nenhuma ação automática foi tomada.',
             'calendar_appointment', $2)`,
    [org, appointmentId],
  );
}

describe("Cadeia real do sinal: reserva → inscrição → T+40 → bloqueios → revisão", () => {
  it("T+40: dentro do prazo, o lembrete PODE sair (nenhum bloqueio do sinal se aplica ainda)", async () => {
    const org = idDeTeste("aaaa", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 40 * 60_000); // T+40: 40min atrás
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000); // consulta bem depois — não capa o prazo
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org);
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });

    const leitura = await lerFatosDoEnvio(pool, {
      organizationId: org,
      contactId,
      conversationId: (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id,
      enrollmentId,
    });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.fatos.reserva).not.toBeNull();

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toEqual({ envia: true });
  });

  it("T+60: prazo vencido — decidirEnvio PARA de mandar (prazo_do_sinal_vencido), lido do banco real", async () => {
    const org = idDeTeste("bbbb", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 61 * 60_000); // T+61: já venceu
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org);
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });

    const conversationId = (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id;
    const leitura = await lerFatosDoEnvio(pool, { organizationId: org, contactId, conversationId, enrollmentId });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toMatchObject({ envia: false, motivo: "prazo_do_sinal_vencido", invalida: true });
  });

  it("T+60 vencido e sem comprovante tratado: abre o aviso interno na Central — e reentrega não duplica", async () => {
    const org = idDeTeste("cccc", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 61 * 60_000);
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    // etapa que NÃO trata o sinal ainda — card na etapa de espera
    const { stageId, pipelineId } = await seedPipelineEStage(org, false);
    await seedLead(org, contactId, pipelineId, stageId);

    const fatos: FatosDaRevisao = {
      reserva: { id: appointmentId, criada_em: criadaEm.toISOString(), consulta_em: consultaEm.toISOString(), sujeita_a_sinal: true, contact_id: contactId },
      etapa_atual_trata_o_sinal: await etapaJaTrataOSinalPg(org, contactId),
      ja_tem_item_aberto: await jaTemItemAbertoPg(org, appointmentId),
    };
    const decisao1 = decidirRevisaoHumana(fatos, agora);
    expect(decisao1).toEqual({ abrir: true });

    await abrirItemDeRevisaoPg(org, appointmentId);
    const { rows: itens } = await pool.query(
      `select kind, severity, ref_kind, ref_id, status from agent_inbox_items where organization_id = $1 and ref_id = $2`,
      [org, appointmentId],
    );
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({ kind: "sinal_revisao_humana", severity: "warn", ref_kind: "calendar_appointment", status: "open" });

    // Reentrega do cron (mesma reserva, mesmo instante ou depois): já tem
    // item aberto — decidirRevisaoHumana não manda abrir de novo.
    const fatos2: FatosDaRevisao = { ...fatos, ja_tem_item_aberto: await jaTemItemAbertoPg(org, appointmentId) };
    expect(fatos2.ja_tem_item_aberto).toBe(true);
    const decisao2 = decidirRevisaoHumana(fatos2, new Date(agora.getTime() + 5 * 60_000));
    expect(decisao2).toEqual({ abrir: false, motivo: "ja_tem_item_aberto" });

    const { rows: contagem } = await pool.query<{ n: string }>(
      `select count(*)::text as n from agent_inbox_items where organization_id = $1 and ref_id = $2`,
      [org, appointmentId],
    );
    expect(contagem[0]!.n).toBe("1"); // nenhuma duplicata
  });

  it("comprovante chegou ANTES do prazo vencer: etapa ainda trata o sinal → revisão NÃO abre (é o caminho feliz)", async () => {
    const org = idDeTeste("dddd", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 61 * 60_000);
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    // etapa que TRATA o sinal (ex.: "Comprovante em conferência") — comprovante já chegou e a equipe moveu o card
    const { stageId, pipelineId } = await seedPipelineEStage(org, true);
    await seedLead(org, contactId, pipelineId, stageId);

    const fatos: FatosDaRevisao = {
      reserva: { id: appointmentId, criada_em: criadaEm.toISOString(), consulta_em: consultaEm.toISOString(), sujeita_a_sinal: true, contact_id: contactId },
      etapa_atual_trata_o_sinal: await etapaJaTrataOSinalPg(org, contactId),
      ja_tem_item_aberto: await jaTemItemAbertoPg(org, appointmentId),
    };
    expect(fatos.etapa_atual_trata_o_sinal).toBe(true);
    expect(decidirRevisaoHumana(fatos, agora)).toEqual({ abrir: false, motivo: "comprovante_ja_tratado" });
  });

  it("comprovante enviado bloqueia o PRÓXIMO lembrete antes de qualquer pessoa mover o card — lido do banco real (não fatos sintéticos)", async () => {
    const org = idDeTeste("eeee", ++orgSeq);
    await seedOrg(org);
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 40 * 60_000); // T+40 — ainda dentro do prazo
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });
    const { pointerId, versionId } = await seedFluxoDoSinal(org); // cancel_on_reply:true
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId, versionId, contactId, appointmentId, startedAt: criadaEm });
    const conversationId = (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id;

    // Card AINDA na etapa antiga — ninguém moveu nada.
    const { stageId, pipelineId } = await seedPipelineEStage(org, false);
    await seedLead(org, contactId, pipelineId, stageId);

    // O comprovante chega como mensagem inbound real, DEPOIS da entrada no
    // fluxo (não há envio anterior registrado em followup_enrollment_events,
    // então a referência de `decidirEnvio` é `enrollment.started_at`).
    const comprovanteEm = new Date(agora.getTime() - 5 * 60_000); // 5min atrás — depois do started_at
    await inserirInbound(org, contactId, conversationId, comprovanteEm);

    const leitura = await lerFatosDoEnvio(pool, { organizationId: org, contactId, conversationId, enrollmentId });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.fatos.ultima_recebida_em).not.toBeNull();

    const decisao = decidirEnvio(leitura.fatos, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, agora);
    expect(decisao).toMatchObject({ envia: false, motivo: "resposta_do_contato", invalida: true });
  });

  it("sequência concorrente entre o fluxo do sinal e um D1/D3/D7 do MESMO contato — com uma_sequencia_por_contato ligado, só a mais antiga segue", async () => {
    const org = idDeTeste("ffff", ++orgSeq);
    const config: ConfigDosBloqueios = { ...CONFIG_SEM_BLOQUEIOS_OPCIONAIS, uma_sequencia_por_contato: true };
    await seedOrg(org, { followups: { bloqueios: config } });
    const contactId = await seedContact(org);
    const eventTypeId = await seedEventType(org, true);
    const agora = new Date();
    const criadaEm = new Date(agora.getTime() - 10 * 60_000);
    const consultaEm = new Date(agora.getTime() + 3 * 60 * 60_000);
    const appointmentId = await seedReserva({ org, contactId, eventTypeId, criadaEm, consultaEm });

    // D1/D3/D7: OUTRO pointer, sem appointment_id, iniciado ANTES do sinal.
    const { pointerId: pointerD1, versionId: versionD1 } = await seedFluxoDoSinal(org);
    const inicioD1 = new Date(agora.getTime() - 60 * 60_000);
    const boundaryD1 = await criarOrigemDeFollowup(pool, org, contactId);
    await pool.query(
      `insert into followup_enrollments (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at, conversation_id, service_boundary, started_at)
       values ($1, $2, $3, $4, 'w1', 'active', now() + interval '1 hour', $5, $6::jsonb, $7)`,
      [org, pointerD1, versionD1, contactId, boundaryD1.conversation_id, JSON.stringify(boundaryD1), inicioD1.toISOString()],
    );

    // Fluxo do sinal: pointer DIFERENTE, iniciado DEPOIS do D1.
    const { pointerId: pointerSinal, versionId: versionSinal } = await seedFluxoDoSinal(org);
    const enrollmentId = await seedInscricaoDoSinal({ org, pointerId: pointerSinal, versionId: versionSinal, contactId, appointmentId, startedAt: agora });
    const conversationId = (await pool.query<{ conversation_id: string }>(`select conversation_id from followup_enrollments where id = $1`, [enrollmentId])).rows[0]!.conversation_id;

    const leitura = await lerFatosDoEnvio(pool, { organizationId: org, contactId, conversationId, enrollmentId });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    // `outras_inscricoes_vivas` não filtra por pointer_id — o D1 já conta.
    expect(leitura.fatos.outras_inscricoes_vivas.length).toBeGreaterThanOrEqual(1);
    // A config efetivamente LIDA e parseada do `organizations.settings` real —
    // não a variável local montada acima só para o seed — é a que decide.
    expect(leitura.config).toEqual(config);

    const decisao = decidirEnvio(leitura.fatos, leitura.config, agora);
    expect(decisao).toMatchObject({ envia: false, motivo: "sequencia_concorrente", invalida: true });
  });
});
