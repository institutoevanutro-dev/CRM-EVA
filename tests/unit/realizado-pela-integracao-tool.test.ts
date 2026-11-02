import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A tool de desfecho só usa o caminho da integração (migration 0401) quando as
 * três condições valem juntas: token de integração, escopo `agenda:outcome` e
 * outcome `completed`. Fora disso, o comportamento antigo (pedir confirmação
 * humana) continua.
 */
const realizado = vi.fn(async () => ({ id: "ap", status: "completed", starts_at: "2026-11-02T12:00:00Z", ends_at: "2026-11-02T13:00:00Z", time_zone: "America/Sao_Paulo" }));
const alterar = vi.fn();
vi.mock("@/app/api/v1/agenda/agendamentos/_handler", () => ({
  registrarRealizadoPelaIntegracaoHandler: realizado,
  alterarAgendamentoHandler: alterar,
  cancelarAgendamentoHandler: vi.fn(),
  marcarAgendamentoHandler: vi.fn(),
}));

const { crmSetAppointmentOutcome } = await import("@/lib/mcp/tools/agendamento");
const AP = "aaaaaaaa-1111-4000-8000-00000000000a";
const ctx = (scopes: string[], type: "api_token" | "ai_agent" = "api_token") =>
  ({
    organizationId: "org",
    role: "ai_operator",
    actor: type === "api_token" ? { type, id: "tok" } : { type, id: "run", role: "ai_operator" },
    apiTokenId: "tok",
    scopes,
    requestId: "req",
    supabase: {},
  }) as never;

beforeEach(() => {
  realizado.mockClear();
  alterar.mockClear();
});

describe("crm_set_appointment_outcome e a integração do prontuário", () => {
  it("token com agenda:outcome registra Realizado com o nome do profissional", async () => {
    const r = (await crmSetAppointmentOutcome.handler({ appointment_id: AP, outcome: "completed", performed_by_name: "Dra. Fictícia" }, ctx(["agenda:outcome", "role:ai_operator"]))) as Record<string, unknown>;
    expect(r.registrado).toBe(true);
    expect(realizado).toHaveBeenCalledWith({}, expect.objectContaining({ organization_id: "org" }), { id: AP, apiTokenId: "tok", performedByName: "Dra. Fictícia" });
  });

  it("falta pela integração continua pedindo a equipe", async () => {
    const r = (await crmSetAppointmentOutcome.handler({ appointment_id: AP, outcome: "no_show" }, ctx(["agenda:outcome", "role:ai_operator"]))) as Record<string, unknown>;
    expect(r.requer_confirmacao_humana).toBe(true);
    expect(realizado).not.toHaveBeenCalled();
  });

  it("token sem o escopo, mesmo com mcp:write, não usa o caminho", async () => {
    const r = (await crmSetAppointmentOutcome.handler({ appointment_id: AP, outcome: "completed" }, ctx(["mcp:write", "role:ai_operator"]))) as Record<string, unknown>;
    expect(r.requer_confirmacao_humana).toBe(true);
    expect(realizado).not.toHaveBeenCalled();
  });

  it("agente de IA com o escopo não usa o caminho", async () => {
    const r = (await crmSetAppointmentOutcome.handler({ appointment_id: AP, outcome: "completed" }, ctx(["agenda:outcome"], "ai_agent"))) as Record<string, unknown>;
    expect(r.requer_confirmacao_humana).toBe(true);
    expect(realizado).not.toHaveBeenCalled();
  });
});
