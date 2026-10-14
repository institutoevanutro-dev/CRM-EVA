/**
 * A BOLHA DA IA NÃO SAI DEPOIS QUE ALGUÉM ASSUMIU A CONVERSA (migration 0361).
 *
 * `sendTurnMessage` confere, antes do ledger e do handler, se o turno ainda tem
 * o comando: Assumir/Transferir revoga o turno no banco, e devolver ao
 * automático não o traz de volta. Porte de melgarafael/DeskcommCRM #2541
 * (@ozzure). A régua do #212 (pessoa no comando, por bolha) continua depois.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handler: vi.fn(), ledger: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: h.handler }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (
    _store: unknown,
    _input: unknown,
    enviar: (key: string, messageId: string) => Promise<unknown>,
  ) => {
    h.ledger();
    await enviar("chave-1", "msg-1");
    return { kind: "sent", idempotencyKey: "chave-1", crmMessageId: "msg-1" };
  },
}));

import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const FRONTEIRA = {
  organization_id: "org-1",
  contact_id: "lead-1",
  conversation_id: "conv-1",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};
const turno = { vigente: true };
const db = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("fn_autonomous_turn_revoked")) return { rows: [{ current: turno.vigente }] };
    if (sql.includes("select payload,kind from job_queue"))
      return { rows: [{ kind: "inbound_turn", payload: { service_boundary: FRONTEIRA } }] };
    if (sql.includes("left join demandas")) return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }] };
    if (sql.includes("cs.metadata"))
      return {
        rows: [
          {
            channel_metadata: { ai_gate_mode: "open" },
            force_human: false,
            assignee_kind: null,
            bot_silenced_until: null,
            ai_authorized_at: null,
            phone_number: "5527999990000",
            provider: "waha",
          },
        ],
      };
    return { rows: [] };
  }),
} as never;

const envia = (jobClaim: { worker_id: string; acquired_at: string } | null = { worker_id: "w", acquired_at: "2026-10-14T12:00:00.123456Z" }) =>
  sendTurnMessage(db, { supabase: {} as never }, {
    tenantId: "org-1",
    leadId: "lead-1",
    jobId: "job-1",
    ...(jobClaim ? { jobClaim } : {}),
    seq: 1,
    conversationId: "conv-1",
    body: "Posso confirmar para amanhã às 10h?",
  });

beforeEach(() => {
  turno.vigente = true;
  h.handler.mockReset();
  h.ledger.mockReset();
  h.handler.mockResolvedValue({ id: "msg-1", status: "sent" });
});

describe("envio da IA depois de Assumir", () => {
  it("controle: com o turno no comando, a bolha sai", async () => {
    await expect(envia()).resolves.toMatchObject({ kind: "sent" });
    expect(h.handler).toHaveBeenCalledTimes(1);
  });

  it("turno revogado (Assumir, mesmo já devolvido): a bolha não entra no ledger nem chega ao canal", async () => {
    turno.vigente = false;
    await expect(envia()).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(h.ledger).not.toHaveBeenCalled();
    expect(h.handler).not.toHaveBeenCalled();
  });

  it("turno autônomo sem lease não envia", async () => {
    await expect(envia(null)).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(h.handler).not.toHaveBeenCalled();
  });
});
