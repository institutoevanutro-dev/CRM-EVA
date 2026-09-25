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

  it("mantém o comportamento dos tokens MCP existentes", () => {
    expect(hasMcpToolScope(["mcp:read"], "crm_list_appointments", "mcp:read")).toBe(true);
    expect(hasMcpToolScope(["mcp:write"], "crm_reschedule_appointment", "mcp:write")).toBe(true);
  });
});
