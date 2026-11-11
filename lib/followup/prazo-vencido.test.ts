import { describe, expect, it } from "vitest";

import { runFollowupTick, type AdminClient } from "./engine";
import type { AppointmentAnchor, FlowGraph } from "./graph-schema";
import { TOLERANCIA_PRAZO_VENCIDO_MS, prazoVencidoDaUltimaEspera, type EnrollmentEventRef, type EnrollmentRow } from "./node-handlers";

/**
 * AÇÃO VENCIDA NÃO É ENVIADA (incidente de 11/11).
 *
 * Presença marcada hoje numa consulta antiga: as esperas ancoradas no dia da
 * consulta (7, 15 dias) já passaram. Antes, o motor mandava as duas mensagens
 * em sequência, minutos depois da marcação. Agora cada mensagem cuja espera
 * venceu além da tolerância é pulada (`action_skipped_overdue`), e o fluxo
 * para na primeira espera cujo prazo ainda está no futuro.
 */
const DIA = 86_400_000;
const HORA = 3_600_000;
const CONSULTA = new Date("2026-10-01T13:00:00.000Z"); // 10:00 em São Paulo

function grafo(anchor: AppointmentAnchor = "appointment_day"): FlowGraph {
  const espera = (id: string, dias: number) => ({
    id,
    type: "wait",
    label: `${dias} dias`,
    position: { x: 0, y: 0 },
    config: { mode: "fixed", duration_ms: dias * DIA, anchor },
  });
  const acao = (id: string) => ({
    id,
    type: "action",
    label: id,
    position: { x: 0, y: 0 },
    config: { mode: "fixed_text", fixed_text: "Oi" },
  });
  const nos = [
    { id: "t", type: "trigger", label: "Compareceu", position: { x: 0, y: 0 }, config: {} },
    espera("w7", 7),
    acao("a7"),
    espera("w15", 15),
    acao("a15"),
    espera("w30", 30),
    acao("a30"),
    { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ];
  return {
    nodes: nos,
    edges: nos.slice(1).map((n, i) => ({
      id: `e${i}`,
      source: nos[i]!.id,
      target: n.id,
      priority: 0,
      condition: { type: "always" },
    })),
  } as unknown as FlowGraph;
}

type Evento = EnrollmentEventRef & { payload: Record<string, unknown> };

function motor(inicio: Date, g = grafo()) {
  let agora = inicio;
  const enrollment = {
    id: "enr-1", organization_id: "org-A", pointer_id: "p-1", version_id: "v-1", contact_id: "c-1",
    conversation_id: null, current_node_id: "t", status: "active", next_eval_at: inicio.toISOString(),
    claimed_until: null, attempts: 0, max_attempts: 5, last_error: null, steps_taken: 0, outcome: null,
    cancel_reason: null, started_at: inicio.toISOString(), completed_at: null, updated_at: inicio.toISOString(),
    appointment_id: "appt-1",
  } as EnrollmentRow;
  const eventos: Evento[] = [];
  const enviados: string[] = [];
  const db = {
    claimDueEnrollments: async () =>
      enrollment.status === "active" && Date.parse(enrollment.next_eval_at!) <= agora.getTime() ? [{ ...enrollment }] : [],
    loadFlowGraph: async () => g,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => eventos.map((e) => ({ ...e })),
    loadLastInboundBody: async () => null,
    loadAppointmentAnchor: async () => CONSULTA.toISOString(),
    loadOrgTimezone: async () => "America/Sao_Paulo",
    async insertEnrollmentEvent(e: Evento) {
      if (eventos.some((x) => x.idempotency_key === e.idempotency_key)) return { inserted: false };
      eventos.push(e);
      return { inserted: true };
    },
    async updateEnrollment(_id: string, _org: string, patch: Partial<EnrollmentRow>) {
      Object.assign(enrollment, patch);
    },
    loadFlowPointerName: async () => "Pós-consulta",
    insertDeadInboxItem: async () => undefined,
    persistirRespostaFollowup: async () => undefined,
  } as unknown as AdminClient;

  /** O que o worker de envio faria: fecha o turno com `action_sent` e avança. */
  function concluirEnvio(nodeId: string) {
    const edge = g.edges.find((e) => e.source === nodeId)!;
    eventos.push({ node_id: nodeId, idempotency_key: `${nodeId}:sent:${enviados.length}`, event_type: "action_sent", payload: {} });
    Object.assign(enrollment, { current_node_id: edge.target, status: "active", next_eval_at: agora.toISOString() });
  }

  async function rodarAte(quando: Date) {
    agora = quando;
    for (let i = 0; i < 40; i++) {
      const pendentes = enviados.length;
      const s = await runFollowupTick({
        db,
        clock: () => agora,
        enqueueJob: async (job) => {
          enviados.push(String((job.payload as { node_id: string }).node_id));
        },
      });
      if (enviados.length > pendentes) concluirEnvio(enviados[enviados.length - 1]!);
      else if (s.claimed === 0) return;
    }
    throw new Error("o motor não estacionou");
  }

  return { enrollment, eventos, enviados, rodarAte };
}

describe("ação vencida não é enviada", () => {
  it("inscrição que nasce atrasada (consulta de 26 dias atrás): pula 7 e 15 dias, estaciona no de 30", async () => {
    const m = motor(new Date(CONSULTA.getTime() + 26 * DIA));
    await m.rodarAte(new Date(CONSULTA.getTime() + 26 * DIA));

    expect(m.enviados).toEqual([]);
    const pulados = m.eventos.filter((e) => e.event_type === "action_skipped_overdue");
    expect(pulados.map((e) => e.node_id)).toEqual(["a7", "a15"]);
    // 7 dias depois do DIA da consulta = 08/10 00:00 em São Paulo.
    expect(pulados[0]!.payload).toMatchObject({ reason: "acao_vencida", devido_em: "2026-10-08T03:00:00.000Z" });
    expect(pulados[0]!.payload.atraso_ms as number).toBeGreaterThan(18 * DIA);
    expect(m.enrollment).toMatchObject({ current_node_id: "w30", status: "active" });
    expect(m.enrollment.next_eval_at).toBe("2026-10-31T03:00:00.000Z");

    // Controle: no dia 30 a mensagem sai normalmente, mesmo com a janela
    // soltando o tick horas depois — está dentro da tolerância.
    await m.rodarAte(new Date(Date.parse("2026-10-31T03:00:00.000Z") + 9 * HORA));
    expect(m.enviados).toEqual(["a30"]);
    expect(m.enrollment.status).toBe("completed");
  });

  it("inscrição que ficou para trás (worker parado além da tolerância): a mensagem não sai", async () => {
    const m = motor(new Date(CONSULTA.getTime() + HORA));
    await m.rodarAte(new Date(CONSULTA.getTime() + HORA));
    expect(m.enrollment.current_node_id).toBe("w7");

    await m.rodarAte(new Date(Date.parse("2026-10-08T03:00:00.000Z") + TOLERANCIA_PRAZO_VENCIDO_MS + HORA));
    expect(m.enviados).toEqual([]);
    expect(m.eventos.filter((e) => e.event_type === "action_skipped_overdue").map((e) => e.node_id)).toEqual(["a7"]);
    expect(m.enrollment.current_node_id).toBe("w15");
  });

  it("controle: atraso dentro da tolerância (worker parado algumas horas) ainda envia", async () => {
    const m = motor(new Date(CONSULTA.getTime() + HORA));
    await m.rodarAte(new Date(CONSULTA.getTime() + HORA));
    await m.rodarAte(new Date(Date.parse("2026-10-08T03:00:00.000Z") + TOLERANCIA_PRAZO_VENCIDO_MS - HORA));
    expect(m.enviados).toEqual(["a7"]);
    expect(m.eventos.some((e) => e.event_type === "action_skipped_overdue")).toBe(false);
  });

  it("controle: âncora na reserva (sinal, lembrete antes da consulta) não é pulada por atraso", async () => {
    const m = motor(new Date(CONSULTA.getTime() + 26 * DIA), grafo("appointment_created_at"));
    await m.rodarAte(new Date(CONSULTA.getTime() + 26 * DIA));
    expect(m.enviados).toEqual(["a7", "a15"]);
    expect(m.eventos.some((e) => e.event_type === "action_skipped_overdue")).toBe(false);
  });
});

describe("prazoVencidoDaUltimaEspera", () => {
  const esperas = new Set(["w7", "w-rel"]);
  const vencida = { node_id: "w7", idempotency_key: "w7:2", event_type: "node_advanced", payload: { reason: "prazo_vencido", devido_em: "2026-10-08T03:00:00.000Z", atraso_ms: 9 * DIA } };

  it("lê o prazo da última espera atravessada", () => {
    expect(prazoVencidoDaUltimaEspera([vencida], esperas)).toEqual({ devido_em: "2026-10-08T03:00:00.000Z", atraso_ms: 9 * DIA });
  });

  it("uma espera posterior que venceu normalmente (ancorada ou não) volta a enviar", () => {
    const normal = { node_id: "w-rel", idempotency_key: "w-rel:5", event_type: "node_advanced", payload: { next_node_id: "a" } };
    expect(prazoVencidoDaUltimaEspera([vencida, normal], esperas)).toBeNull();
  });

  it("espera avançada sem o seu node_advanced (resgate de replay) não herda o vencido da anterior", () => {
    const resgatada = { node_id: "w-rel", idempotency_key: "w-rel:5", event_type: "wait_started", payload: {} };
    expect(prazoVencidoDaUltimaEspera([vencida, resgatada], esperas)).toBeNull();
  });
});
