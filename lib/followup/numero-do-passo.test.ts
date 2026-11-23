import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { CHANNEL_PROVIDER_META, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

import { conferirAntesDoEnvio } from "./bloqueios-obrigatorios";
import { runFollowupTick, type AdminClient, type FollowupJobRequest } from "./engine";
import { actionConfigSchema, type FlowGraph } from "./graph-schema";
import { EVENTO_TETO_DE_PRIMEIRO_CONTATO, rechecksOciososDaAcao, type EnrollmentRow } from "./node-handlers";
import {
  bancoDoNumeroSupabase,
  conversaNoNumeroDoPasso,
  tetoDePrimeirosContatos,
  type BancoDoNumero,
  type EnvioPeloNumero,
} from "./numero-do-passo";

/**
 * "Enviar pelo número" do passo de envio: o F4 do fluxo de silêncio sai por um
 * número não oficial, e não pelo oficial da conversa (janela de 24h fechada).
 */

const ORG = "org-1";
const CANAL_NAO_OFICIAL = "11111111-1111-4111-8111-111111111111";
const SP = "America/Sao_Paulo";
// 22/11/2026 15:00 em Brasília.
const AGORA = new Date("2026-11-22T18:00:00.000Z");

const fronteira = (conversation_id: string): ServiceBoundary => ({
  organization_id: ORG,
  contact_id: "c-1",
  conversation_id,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
});

function banco(over: Partial<BancoDoNumero> & { provider?: string | null; existe?: boolean; usados?: number } = {}) {
  const abrirConversa = vi.fn(async () => fronteira("conv-no-numero"));
  const b: BancoDoNumero = {
    lerCanal: async (org) =>
      org === ORG && over.provider !== null
        ? { data: { provider: over.provider ?? DEFAULT_CHANNEL_PROVIDER, archived_at: null }, error: null }
        : { data: null, error: null },
    temConversa: async () => over.existe ?? false,
    conversasNovasSemResposta: async () => over.usados ?? 0,
    abrirConversa,
    ...over,
  };
  return { b, abrirConversa };
}

const pedir = (b: BancoDoNumero, org = ORG, teto = 20) =>
  conversaNoNumeroDoPasso(b, { org, contactId: "c-1", channelSessionId: CANAL_NAO_OFICIAL, agora: AGORA, fuso: SP, teto });

describe("conversaNoNumeroDoPasso", () => {
  it("conversa já existe no número: reaproveita (reabre se fechada) e não conta no teto", async () => {
    const { b, abrirConversa } = banco({ existe: true, usados: 999 });
    expect(await pedir(b)).toEqual({ kind: "ok", boundary: fronteira("conv-no-numero"), criada: false });
    expect(abrirConversa).toHaveBeenCalledWith(ORG, "c-1", CANAL_NAO_OFICIAL);
  });

  it("sem conversa no número e abaixo do teto: cria pelo caminho das automações", async () => {
    const { b, abrirConversa } = banco({ existe: false, usados: 19 });
    expect(await pedir(b)).toEqual({ kind: "ok", boundary: fronteira("conv-no-numero"), criada: true });
    expect(abrirConversa).toHaveBeenCalledOnce();
  });

  it("canal de outra organização: recusado e nenhuma conversa criada", async () => {
    const { b, abrirConversa } = banco();
    const r = await pedir(b, "org-2");
    expect(r).toEqual({ kind: "recusado", message: "O número escolhido para o envio não existe nesta conta. Escolha outro." });
    expect(abrirConversa).not.toHaveBeenCalled();
  });

  it("teto diário atingido num número com risco de ban: segura até a meia-noite seguinte do fuso", async () => {
    const { b, abrirConversa } = banco({ existe: false, usados: 20 });
    const conferidos: Date[] = [];
    b.conversasNovasSemResposta = async (_o, _c, desde) => (conferidos.push(desde), 20);
    const r = await pedir(b);
    expect(r).toEqual({ kind: "teto", ate: new Date("2026-11-23T03:00:00.000Z"), usados: 20, teto: 20 });
    expect(conferidos).toEqual([new Date("2026-11-22T03:00:00.000Z")]);
    expect(abrirConversa).not.toHaveBeenCalled();
  });

  it("número oficial (sem risco de ban) não tem teto de primeiro contato", async () => {
    const { b } = banco({ provider: CHANNEL_PROVIDER_META, existe: false, usados: 999 });
    expect((await pedir(b)).kind).toBe("ok");
  });

  it("knob: vazio ou lixo = 20; zero vale", () => {
    expect(tetoDePrimeirosContatos(undefined)).toBe(20);
    expect(tetoDePrimeirosContatos("")).toBe(20);
    expect(tetoDePrimeirosContatos("vinte")).toBe(20);
    expect(tetoDePrimeirosContatos("-3")).toBe(20);
    expect(tetoDePrimeirosContatos("0")).toBe(0);
    expect(tetoDePrimeirosContatos("50")).toBe(50);
  });
});

describe("schema do nó de envio", () => {
  it("aceita o número em qualquer modo; recusa o que não é uuid", () => {
    expect(actionConfigSchema.safeParse({ mode: "text", body: "oi", channel_session_id: CANAL_NAO_OFICIAL }).success).toBe(true);
    expect(actionConfigSchema.safeParse({ mode: "ai_message", prompt_hint: "x", channel_session_id: CANAL_NAO_OFICIAL }).success).toBe(true);
    expect(actionConfigSchema.safeParse({ mode: "text", body: "oi", channel_session_id: "numero-1" }).success).toBe(false);
    expect(actionConfigSchema.safeParse({ mode: "text", body: "oi" }).success).toBe(true);
  });
});

describe("motor: passo com número próprio", () => {
  const grafo = (numero?: string): FlowGraph =>
    ({
      nodes: [
        {
          id: "f4",
          type: "action",
          label: "F4",
          position: { x: 0, y: 0 },
          config: { mode: "text", body: "oi", ...(numero ? { channel_session_id: numero } : {}) },
        },
        { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
      ],
      edges: [{ id: "f4-fim", source: "f4", target: "fim", priority: 0, condition: { type: "always" } }],
    }) as FlowGraph;

  function loja(numero: string | undefined, envio?: EnvioPeloNumero) {
    const enrollment = {
      id: "enr-1", organization_id: ORG, pointer_id: "p-1", version_id: "v-1", contact_id: "c-1",
      conversation_id: "conv-oficial", service_boundary: fronteira("conv-oficial"), current_node_id: "f4",
      status: "active", next_eval_at: AGORA.toISOString(), claimed_until: null, attempts: 0, max_attempts: 5,
      last_error: null, steps_taken: 3, outcome: null, cancel_reason: null, started_at: AGORA.toISOString(),
      completed_at: null, updated_at: AGORA.toISOString(),
    } as EnrollmentRow;
    const eventos: { event_type: string; idempotency_key: string; payload: Record<string, unknown> }[] = [];
    const jobs: FollowupJobRequest[] = [];
    const mortos: string[] = [];
    const pedido = vi.fn(async () => envio!);
    const db = {
      claimDueEnrollments: async () =>
        enrollment.next_eval_at && Date.parse(enrollment.next_eval_at) <= AGORA.getTime() ? [{ ...enrollment }] : [],
      loadFlowGraph: async () => grafo(numero),
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadEnrollmentEvents: async () => [],
      loadLastInboundBody: async () => null,
      async insertEnrollmentEvent(e) {
        eventos.push(e);
        return { inserted: true };
      },
      async updateEnrollment(_id, _org, patch) {
        Object.assign(enrollment, patch);
      },
      loadFlowPointerName: async () => "Silêncio",
      insertDeadInboxItem: async (i) => void mortos.push(i.body),
      persistirRespostaFollowup: async () => undefined,
      ...(envio ? { conversaNoNumeroDoPasso: pedido } : {}),
    } as AdminClient;
    const tick = () => runFollowupTick({ db, clock: () => AGORA, enqueueJob: async (j) => void jobs.push(j) });
    return { enrollment, eventos, jobs, mortos, pedido, tick };
  }

  it("nó sem número: igual a hoje — o job leva a fronteira da conversa do contato", async () => {
    const l = loja(undefined, { kind: "ok", boundary: fronteira("nao-usar"), criada: false });
    await l.tick();
    expect(l.pedido).not.toHaveBeenCalled();
    expect(l.jobs).toHaveLength(1);
    expect(l.jobs[0]!.payload.service_boundary).toEqual(fronteira("conv-oficial"));
  });

  it("⭐ nó com número: o job leva a fronteira da conversa NESSE número", async () => {
    const l = loja(CANAL_NAO_OFICIAL, { kind: "ok", boundary: fronteira("conv-nao-oficial"), criada: true });
    await l.tick();
    expect(l.pedido).toHaveBeenCalledWith({ organization_id: ORG, contact_id: "c-1", channel_session_id: CANAL_NAO_OFICIAL, agora: AGORA });
    expect(l.jobs).toHaveLength(1);
    expect(l.jobs[0]!.payload.service_boundary).toEqual(fronteira("conv-nao-oficial"));
    expect(l.eventos.map((e) => e.event_type)).toEqual(["turn_enqueued"]);
  });

  it("canal recusado (outra organização): falha registrada na Central e nada enfileirado", async () => {
    const l = loja(CANAL_NAO_OFICIAL, { kind: "recusado", message: "O número escolhido para o envio não existe nesta conta. Escolha outro." });
    await l.tick();
    expect(l.jobs).toHaveLength(0);
    expect(l.enrollment.status).toBe("dead");
    expect(l.mortos[0]).toContain("não existe nesta conta");
  });

  it("adapter sem o recurso: falha fechada, nunca sai pelo número da conversa", async () => {
    const l = loja(CANAL_NAO_OFICIAL);
    await l.tick();
    expect(l.jobs).toHaveLength(0);
    expect(l.enrollment.status).toBe("dead");
  });

  it("⭐ teto diário: o passo fica no nó, volta amanhã, e o dossiê diz por quê", async () => {
    const ate = new Date("2026-11-23T03:00:00.000Z");
    const l = loja(CANAL_NAO_OFICIAL, { kind: "teto", ate, usados: 20, teto: 20 });
    await l.tick();
    expect(l.jobs).toHaveLength(0);
    expect(l.enrollment.current_node_id).toBe("f4");
    expect(l.enrollment.status).toBe("active");
    expect(l.enrollment.steps_taken).toBe(3);
    expect(l.enrollment.next_eval_at).toBe(ate.toISOString());
    expect(l.eventos).toEqual([
      {
        organization_id: ORG, enrollment_id: "enr-1", node_id: "f4", event_type: EVENTO_TETO_DE_PRIMEIRO_CONTATO,
        payload: { next_eval_at: ate.toISOString(), usados: 20, teto: 20 },
        idempotency_key: `f4:3:teto:${ate.toISOString()}`,
      },
    ]);
  });

  it("dias segurados pelo teto não gastam o orçamento do dead-man", () => {
    const ev = (event_type: string) => ({ node_id: "f4", event_type, idempotency_key: null, payload: {} });
    expect(
      rechecksOciososDaAcao(
        [ev(EVENTO_TETO_DE_PRIMEIRO_CONTATO), ev(EVENTO_TETO_DE_PRIMEIRO_CONTATO), ev("turn_enqueued")],
        "f4",
      ),
    ).toBe(1);
  });
});

describe("travas do número de destino", () => {
  // O envio confere a conversa da FRONTEIRA DO JOB (`enviar-texto-fixo`, `followup-turn`);
  // com o número próprio, é a conversa desse número, e a liberação lida é a do canal dela.
  function pool(porConversa: Record<string, Record<string, unknown>>) {
    const query = async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from followup_enrollments e")) return { rows: [{
        id: "enr-1", status: "active", started_at: new Date("2026-11-20T10:00:00Z"), pointer_id: "p-1",
        trigger_config: { kind: "manual" }, appointment_id: null, appointment_revision: null,
        reserva_criada_em: null, reserva_consulta_em: null, reserva_sujeita_a_sinal: null, reserva_status: null,
      }] };
      if (sql.includes("from contacts")) return { rows: [{ is_blocked: false, force_human: false, is_anonymized: false, phone_number: "+5527999990000" }] };
      if (sql.includes("from conversations c")) return { rows: [porConversa[params[1] as string]] };
      if (sql.includes("from organizations")) return { rows: [{ settings: {} }] };
      return { rows: [] };
    };
    return { query } as unknown as Pick<pg.Pool, "query">;
  }
  const preGoLive = { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: ["+5527911112222"] };

  it("pre_go_live do número escolhido barra o passo, mesmo com o número da conversa liberado", async () => {
    const p = pool({
      "conv-oficial": { bot_silenciado: false, provider: CHANNEL_PROVIDER_META, last_inbound_at: null, canal_metadata: {} },
      "conv-nao-oficial": { bot_silenciado: false, provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: null, canal_metadata: preGoLive },
    });
    const base = { organizationId: ORG, contactId: "c-1", enrollmentId: "enr-1" };
    const quarta = new Date("2026-11-25T14:00:00.000Z");
    expect(await conferirAntesDoEnvio(p, { ...base, conversationId: "conv-oficial" }, quarta, "fixo")).toEqual({ envia: true });
    expect(await conferirAntesDoEnvio(p, { ...base, conversationId: "conv-nao-oficial" }, quarta, "fixo")).toEqual({
      envia: false,
      motivo: "conversa_nao_liberada",
      invalida: true,
    });
  });
});

describe("adapter Supabase: tudo filtrado pela organização", () => {
  function fake(resposta: { data?: unknown; count?: number }) {
    const chamadas: [string, unknown[]][] = [];
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ ...resposta, error: null });
          return (...args: unknown[]) => (chamadas.push([String(prop), args]), chain);
        },
      },
    );
    return { admin: { from: (t: string) => (chamadas.push(["from", [t]]), chain) } as unknown as SupabaseClient, chamadas };
  }

  it("canal, conversa existente e contagem do teto", async () => {
    const canal = fake({ data: null });
    await bancoDoNumeroSupabase(canal.admin).lerCanal(ORG, CANAL_NAO_OFICIAL);
    expect(canal.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);

    const conversa = fake({ data: [{ id: "x" }] });
    expect(await bancoDoNumeroSupabase(conversa.admin).temConversa(ORG, "c-1", CANAL_NAO_OFICIAL)).toBe(true);
    expect(conversa.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(conversa.chamadas).toContainEqual(["eq", ["channel_session_id", CANAL_NAO_OFICIAL]]);

    const conta = fake({ count: 7 });
    const desde = new Date("2026-11-22T03:00:00.000Z");
    expect(await bancoDoNumeroSupabase(conta.admin).conversasNovasSemResposta(ORG, CANAL_NAO_OFICIAL, desde)).toBe(7);
    expect(conta.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(conta.chamadas).toContainEqual(["is", ["last_inbound_at", null]]);
    expect(conta.chamadas).toContainEqual(["gte", ["created_at", desde.toISOString()]]);
  });
});
