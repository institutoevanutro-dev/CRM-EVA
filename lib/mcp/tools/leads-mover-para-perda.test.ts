/**
 * `crm_move_lead_stage` precisa levar o motivo da perda até o handler.
 *
 * Etapa de perda exige `lost_reason` (issue #917), e o `moveLeadHandler` já o
 * aceita — mas o shape da ferramenta não declarava a chave, então todo cliente
 * MCP (ex.: o Prontuário movendo o card para "Não comprou") recebia
 * `lost_reason_required` sem ter como mandar o motivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const moveLeadHandler = vi.fn();
vi.mock("@/app/api/v1/leads/_handler", () => ({
  listLeadsHandler: vi.fn(), getLeadHandler: vi.fn(), createLeadHandler: vi.fn(), updateLeadHandler: vi.fn(),
  moveLeadHandler: (...a: unknown[]) => moveLeadHandler(...a),
}));

import { crmMoveLeadStage } from "./leads";

const LEAD = "11111111-2222-4333-8444-555555555555";
const ETAPA = "66666666-7777-4888-8999-000000000000";
const ctx = { supabase: {}, organizationId: "org", actor: {}, requestId: "r" } as never;

beforeEach(() => { moveLeadHandler.mockReset(); moveLeadHandler.mockResolvedValue({ id: LEAD }); });

describe("crm_move_lead_stage — motivo da perda", () => {
  it("entrega lost_reason ao handler", async () => {
    const entrada = z.object(crmMoveLeadStage.inputSchema).parse({ lead_id: LEAD, to_stage_id: ETAPA, reason: "Não fechou", lost_reason: "other" });
    await crmMoveLeadStage.handler(entrada, ctx);
    expect(moveLeadHandler.mock.calls[0]?.[3]).toMatchObject({ to_stage_id: ETAPA, reason: "Não fechou", lost_reason: "other" });
  });

  it("segue opcional para etapa que não é de perda (controle)", async () => {
    const entrada = z.object(crmMoveLeadStage.inputSchema).parse({ lead_id: LEAD, to_stage_id: ETAPA });
    await crmMoveLeadStage.handler(entrada, ctx);
    expect(moveLeadHandler.mock.calls[0]?.[3]?.lost_reason).toBeUndefined();
  });
});
