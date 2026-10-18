import { describe, expect, it } from "vitest";

import { runFollowupTick, type AdminClient } from "./engine";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";

/**
 * Âncora `appointment_day` pelo motor: o fuso que decide o "dia" é o da
 * ORGANIZAÇÃO (lido de `organizations.timezone`), não um -03:00 fixo.
 */
const AGORA = new Date("2026-10-21T06:00:00.000Z"); // 21/10 15:00 em Tóquio
const DIA = 86_400_000;

function loja(fusoDaOrg: string | null) {
  const grafo = {
    nodes: [
      { id: "espera", type: "wait", label: "7 dias", position: { x: 0, y: 0 }, config: { mode: "fixed", duration_ms: 7 * DIA, anchor: "appointment_day" } },
      { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
    ],
    edges: [{ id: "e", source: "espera", target: "fim", priority: 0, condition: { type: "always" } }],
  } as FlowGraph;
  const enrollment = {
    id: "enr-1", organization_id: "org-A", pointer_id: "p-1", version_id: "v-1", contact_id: "c-1",
    conversation_id: null, current_node_id: "espera", status: "active", next_eval_at: AGORA.toISOString(),
    claimed_until: null, attempts: 0, max_attempts: 5, last_error: null, steps_taken: 0, outcome: null,
    cancel_reason: null, started_at: AGORA.toISOString(), completed_at: null, updated_at: AGORA.toISOString(),
    appointment_id: "appt-1",
  } as EnrollmentRow;
  const fusoPedidoPara: string[] = [];
  let reivindicado = false;
  const db = {
    claimDueEnrollments: async () => (reivindicado ? [] : ((reivindicado = true), [{ ...enrollment }])),
    loadFlowGraph: async () => grafo,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async () => [],
    loadLastInboundBody: async () => null,
    loadAppointmentAnchor: async () => AGORA.toISOString(),
    async loadOrgTimezone(orgId: string) {
      fusoPedidoPara.push(orgId);
      return fusoDaOrg;
    },
    insertEnrollmentEvent: async () => ({ inserted: true }),
    async updateEnrollment(_id: string, _org: string, patch: Partial<EnrollmentRow>) {
      Object.assign(enrollment, patch);
    },
    loadFlowPointerName: async () => "Pós-consulta",
    insertDeadInboxItem: async () => undefined,
    persistirRespostaFollowup: async () => undefined,
  } as unknown as AdminClient;
  const tick = () => runFollowupTick({ db, clock: () => AGORA, enqueueJob: async () => undefined });
  return { enrollment, fusoPedidoPara, tick };
}

describe("espera no dia da consulta, pelo motor", () => {
  it("usa o fuso da organização: 28/10 00:00 em Tóquio", async () => {
    const l = loja("Asia/Tokyo");
    await l.tick();
    expect(l.fusoPedidoPara).toEqual(["org-A"]);
    expect(l.enrollment.next_eval_at).toBe("2026-10-27T15:00:00.000Z");
  });

  it("fuso inutilizável cai em America/Sao_Paulo (21/10 03:00 SP → 28/10 00:00 SP)", async () => {
    const l = loja("Terra/Média");
    await l.tick();
    expect(l.enrollment.next_eval_at).toBe("2026-10-28T03:00:00.000Z");
  });
});
