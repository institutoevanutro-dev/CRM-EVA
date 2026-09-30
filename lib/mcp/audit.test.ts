import { describe, it, expect, vi, beforeEach } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { auditMcpToolCall } from "./audit";
import type { McpContext } from "./types";

const ctx = {
  organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  requestId: "req-1",
  // Um token comum vira actor.type='user' com id = id do TOKEN (lib/mcp/auth.ts).
  actor: { type: "user", id: "d7ba0e68-0000-4000-8000-000000000001", role: "manager" },
} as unknown as McpContext;

describe("auditMcpToolCall", () => {
  beforeEach(() => auditSpy.mockClear());

  it("não manda o nome da tool em resource_id (coluna uuid no banco)", async () => {
    // Defeito de origem: resourceId recebia "crm_create_lead" e todo insert
    // morria com «invalid input syntax for type uuid», em silêncio — nenhuma
    // chamada MCP era auditada.
    await auditMcpToolCall({
      ctx, toolName: "crm_create_lead", args: {}, durationMs: 12, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.resourceId).toBeNull();
    expect(e.resourceType).toBe("mcp_tool");
    expect(e.metadata.tool_name).toBe("crm_create_lead");
  });

  it("não manda id de token em actorUserId (FK para auth.users)", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_list_leads", args: {}, durationMs: 5, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.actorUserId).toBeNull();
    expect(e.actorApiTokenId).toBe(ctx.apiTokenId);
  });

  it("escreve os campos de que o painel de uso depende para ler", async () => {
    // Contrato entre as duas pontas. `fn_agent_tool_usage` (migration 0103)
    // agrega por `action='mcp.tool_called'`, lê `metadata->>'tool_name'`,
    // conta falha por `metadata->>'success' = 'false'` e amarra a chamada ao
    // agente por `request_id = ai_agent_runs.id`. Renomear qualquer um destes
    // aqui zera o painel na tela sem quebrar teste nenhum do emissor — e "0
    // usos" é indistinguível de "nunca usada".
    await auditMcpToolCall({
      ctx, toolName: "crm_move_lead_stage", args: {}, durationMs: 9,
      success: false, errorMessage: "stage_not_found",
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.action).toBe("mcp.tool_called");
    expect(e.requestId).toBe(ctx.requestId);
    expect(e.metadata.tool_name).toBe("crm_move_lead_stage");
    expect(e.metadata.success).toBe(false);
  });

  it("guarda só ids, enums, números e booleanos — texto livre vira [redacted]", async () => {
    // A6: a trilha é imutável e fica anos. Texto da mensagem, telefone, nome e
    // nota do paciente não podem ficar lá depois de um pedido de exclusão.
    await auditMcpToolCall({
      ctx, toolName: "crm_send_message",
      args: {
        contact_id: "11111111-1111-4111-8111-111111111111",
        conversation_ids: ["22222222-2222-4222-8222-222222222222"],
        campo: "email", limit: 10, only_active: true,
        cpf: "12345678900", query: "joana", body: "meu exame deu positivo",
        phone: "+55 11 99999-0000", name: "Joana", notes: null,
        metadata: { telefone: "11999990000" },
      },
      durationMs: 3, success: true,
    });
    const args = auditSpy.mock.calls[0]![0].metadata.args;
    expect(args.contact_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(args.conversation_ids).toEqual(["22222222-2222-4222-8222-222222222222"]);
    expect(args.campo).toBe("email");
    expect(args.limit).toBe(10);
    expect(args.only_active).toBe(true);
    for (const k of ["cpf", "query", "body", "phone", "name", "metadata"]) {
      expect(args[k]).toBe("[redacted]");
    }
    expect(args.notes).toBeNull();
    expect(JSON.stringify(args)).not.toMatch(/joana|positivo|99999|11999990000/i);
  });

  it("id com texto livre dentro não passa (campo *_id não é salvo-conduto)", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_get_contact",
      args: { contact_id: "Joana da Silva 11 99999-0000" },
      durationMs: 3, success: true,
    });
    expect(auditSpy.mock.calls[0]![0].metadata.args.contact_id).toBe("[redacted]");
  });

  it("result_summary é só contagem", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_list_contacts", args: {}, durationMs: 3, success: true,
      resultSummary: "3 contacts",
    });
    expect(auditSpy.mock.calls[0]![0].metadata.result_summary).toBe("3 contacts");
  });
});
