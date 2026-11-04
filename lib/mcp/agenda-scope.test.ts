import { describe, expect, it } from "vitest";

import { hasMcpToolScope } from "./agenda-scope";

describe("token exclusivo da agenda", () => {
  const agenda = ["agenda:read", "agenda:reschedule", "role:ai_operator"];

  it("permite listar e remarcar compromissos", () => {
    expect(hasMcpToolScope(agenda, "crm_list_appointments", "mcp:read")).toBe(true);
    expect(hasMcpToolScope(agenda, "crm_reschedule_appointment", "mcp:write")).toBe(true);
  });

  it("recusa outras leituras e escritas, inclusive outras ações da agenda", () => {
    for (const [name, scope] of [
      ["crm_list_contacts", "mcp:read"],
      ["crm_book_appointment", "mcp:write"],
      ["crm_cancel_appointment", "mcp:write"],
      ["crm_confirm_appointment", "mcp:write"],
    ] as const) {
      expect(hasMcpToolScope(agenda, name, scope)).toBe(false);
    }
  });

  it("agenda:outcome abre só a tool de desfecho", () => {
    const realizado = ["agenda:outcome", "role:ai_operator"];
    expect(hasMcpToolScope(realizado, "crm_set_appointment_outcome", "mcp:write")).toBe(true);
    for (const [name, scope] of [
      ["crm_list_appointments", "mcp:read"],
      ["crm_reschedule_appointment", "mcp:write"],
      ["crm_cancel_appointment", "mcp:write"],
      ["crm_book_appointment", "mcp:write"],
    ] as const) {
      expect(hasMcpToolScope(realizado, name, scope)).toBe(false);
    }
    expect(hasMcpToolScope(agenda, "crm_set_appointment_outcome", "mcp:write")).toBe(false);
  });

  it("prontuario:funil abre só as cinco tools do funil", () => {
    const funil = ["prontuario:funil"];
    for (const [name, scope] of [
      ["crm_list_pipelines", "mcp:read"],
      ["crm_list_stages", "mcp:read"],
      ["crm_create_lead", "mcp:write"],
      ["crm_update_lead", "mcp:write"],
      ["crm_move_lead_stage", "mcp:write"],
    ] as const) {
      expect(hasMcpToolScope(funil, name, scope)).toBe(true);
    }
    for (const [name, scope] of [
      ["crm_list_contacts", "mcp:read"],
      ["crm_list_appointments", "mcp:read"],
      ["crm_send_message", "mcp:write"],
      ["crm_reschedule_appointment", "mcp:write"],
      // Leitura não vira escrita: a tool de leitura pedida como escrita fica fechada.
      ["crm_list_pipelines", "mcp:write"],
    ] as const) {
      expect(hasMcpToolScope(funil, name, scope)).toBe(false);
    }
    expect(hasMcpToolScope(["agenda:read"], "crm_create_lead", "mcp:write")).toBe(false);
  });

  it("mantém o comportamento dos tokens MCP existentes", () => {
    expect(hasMcpToolScope(["mcp:read"], "crm_list_appointments", "mcp:read")).toBe(true);
    expect(hasMcpToolScope(["mcp:write"], "crm_reschedule_appointment", "mcp:write")).toBe(true);
  });
});
