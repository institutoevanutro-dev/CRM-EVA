import { describe, expect, it } from "vitest";

import { SCENARIO_READS } from "@/lib/agent-engine/agent/preview";
import { getToolByName } from "@/lib/mcp/tools";

/**
 * O Testar do agente roda SEM contato. Só as leituras da ORGANIZAÇÃO podem
 * passar nesse modo; dado de contato/lead continua exigindo contato real.
 * Porte de melgarafael/DeskcommCRM #1649 (4cbc3633a7).
 */
describe("leituras de cenário da prévia", () => {
  it("consulta catálogo e acervo da organização no modo teste, sem contato", () => {
    expect(SCENARIO_READS.has("crm_search_products")).toBe(true);
    expect(SCENARIO_READS.has("crm_search_knowledge")).toBe(true);
  });

  it("dado de contato continua exigindo contato real no modo teste", () => {
    expect(SCENARIO_READS.has("crm_get_contact")).toBe(false);
    expect(SCENARIO_READS.has("crm_search_contacts")).toBe(false);
    expect(SCENARIO_READS.has("crm_get_lead")).toBe(false);
    expect(SCENARIO_READS.has("crm_list_leads")).toBe(false);
  });

  it("todo nome da lista é uma ferramenta que existe no catálogo", () => {
    // Um nome errado aqui não quebra nada à vista: a ferramenta certa só fica
    // bloqueada no Testar. Foi o caso de `crm_list_appointment_types`, que
    // escondia a lista de atendimentos e impedia a IA de achar o horário.
    const inexistentes = [...SCENARIO_READS].filter((nome) => !getToolByName(nome));
    expect(inexistentes).toEqual([]);
  });

  it("libera a lista de atendimentos, primeiro passo para consultar horários", () => {
    expect(SCENARIO_READS.has("crm_list_event_types")).toBe(true);
  });
});
