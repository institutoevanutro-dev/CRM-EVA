import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionCtx } from "@/lib/automation/types";

vi.mock("@/lib/followup/enroll", () => ({
  enrollFollowupFlow: vi.fn(),
}));

import { enrollFollowupFlow } from "@/lib/followup/enroll";
import { executeStartMessageFlow } from "@/lib/automation/actions/start-message-flow";

const enroll = vi.mocked(enrollFollowupFlow);
const POINTER = "11111111-1111-4111-8111-111111111111";

function baseCtx(context: Record<string, unknown>): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Automação de teste",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context,
  };
}

describe("executeStartMessageFlow", () => {
  beforeEach(() => {
    enroll.mockReset();
  });

  it("skip: sem contato no contexto", async () => {
    const result = await executeStartMessageFlow(baseCtx({ lead: { id: "lead-1" } }), {
      flow_pointer_id: POINTER,
    });
    expect(result).toEqual({
      type: "start_message_flow",
      status: "skipped",
      detail: { reason: "no_contact" },
    });
    expect(enroll).not.toHaveBeenCalled();
  });

  it("skip: fluxo ainda não publicado", async () => {
    enroll.mockResolvedValue({
      ok: false,
      code: "flow_not_active",
      message: "Fluxo não está ativo (precisa estar publicado).",
      status: 422,
    });
    const result = await executeStartMessageFlow(
      baseCtx({ contact: { id: "c-1" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toEqual({ reason: "flow_not_active" });
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        pointerId: POINTER,
        contactId: "c-1",
        requestId: "rule:rule-1",
      }),
    );
  });

  it("usa contact_id do lead quando contact não veio hidratado", async () => {
    enroll.mockResolvedValue({ ok: true, enrollment: { id: "enr-1" } });
    const result = await executeStartMessageFlow(
      baseCtx({ lead: { id: "lead-1", contact_id: "c-from-lead" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("success");
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: "c-from-lead" }),
    );
  });

  it("vincula o fluxo de sinal à reserva do evento de agenda quando configurado", async () => {
    enroll.mockResolvedValue({ ok: true, enrollment: { id: "enr-1" } });
    const ctx = baseCtx({
      contact: { id: "c-1" },
      appointment: { id: "appointment-1", contact_id: "c-1", status: "pending" },
    });
    ctx.event.entity_kind = "calendar_appointment";
    ctx.event.entity_id = "appointment-1";
    ctx.event.event_type = "appointment.created";
    const result = await executeStartMessageFlow(ctx, {
      flow_pointer_id: POINTER,
      bind_appointment: true,
    });
    expect(result.status).toBe("success");
    expect(enroll).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ appointmentId: "appointment-1" }));
  });

  it("recusa vínculo de sinal sem reserva válida do mesmo contato", async () => {
    const ctx = baseCtx({
      contact: { id: "c-1" },
      appointment: { id: "appointment-1", contact_id: "c-2", status: "pending" },
    });
    ctx.event.entity_kind = "calendar_appointment";
    ctx.event.entity_id = "appointment-1";
    ctx.event.event_type = "appointment.created";
    const result = await executeStartMessageFlow(ctx, {
      flow_pointer_id: POINTER,
      bind_appointment: true,
    });
    expect(result).toMatchObject({ status: "skipped" });
    expect(enroll).not.toHaveBeenCalled();
  });

  it("falha explícita em inscrição viva (conflict)", async () => {
    enroll.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "já ativo",
      status: 409,
    });
    const result = await executeStartMessageFlow(
      baseCtx({ contact: { id: "c-1" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("live_enrollment_exists");
  });
});
