import { describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/contacts/proposta-de-dado", () => ({
  CAMPOS_PROPONIVEIS: ["email", "name", "phone_number"],
  proporDadoDoContato: async () => ({
    criada: true, id: "33333333-3333-4333-8333-333333333333", valorAnterior: "Joana Antiga",
  }),
}));

import { crmProposeContactField } from "./contacts";
import type { McpContext } from "../types";

describe("crm_propose_contact_field — auditoria sem dado pessoal (A6)", () => {
  it("não grava valor anterior nem proposto na trilha", async () => {
    const ctx = {
      organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0", requestId: "r", supabase: {},
      actor: { type: "user", id: "d7ba0e68-0000-4000-8000-000000000001" },
    } as unknown as McpContext;
    await crmProposeContactField.handler(
      { contact_id: "11111111-1111-4111-8111-111111111111", campo: "name", valor: "Joana Nova" } as never,
      ctx,
    );
    const e = auditSpy.mock.calls[0]![0];
    expect(e.metadata).toEqual({
      actor_type: "user", proposal_id: "33333333-3333-4333-8333-333333333333", campo: "name",
    });
    expect(JSON.stringify(e)).not.toMatch(/Joana/);
  });
});
