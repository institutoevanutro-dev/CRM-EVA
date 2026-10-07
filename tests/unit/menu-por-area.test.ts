import { describe, expect, it } from "vitest";
import { abasDaArea, areaDaRota, areasDoMenu, NAV_GROUPS } from "@/lib/navigation/registry";

// Spec 2026-10-07-cores-e-menu: menu lateral com 6 áreas; abas no topo de cada área.
describe("menu por área", () => {
  it("seis áreas, CRM se chama Vendas, Canais não é área", () => {
    const areas = areasDoMenu(false, "admin");
    expect(areas.map((a) => a.label)).toEqual(["Início", "Atendimento", "Vendas", "IA", "Análise", "Organização"]);
    expect(NAV_GROUPS.some((g) => (g.id as string) === "canais")).toBe(false);
  });
  it("rota do catálogo marca a área e a aba", () => {
    expect(areaDaRota("/app/contacts")).toEqual({ area: "crm", abaHref: "/app/contacts" });
    expect(areaDaRota("/app/connections")).toEqual({ area: "organizacao", abaHref: "/app/connections" });
    expect(areaDaRota("/app/ai/agents/123")).toEqual({ area: "ia", abaHref: "/app/ai/agents" });
  });
  it("quadro do funil e detalhe do lead ficam em Vendas", () => {
    expect(areaDaRota("/app/pipelines/abc")).toEqual({ area: "crm", abaHref: "/app/kanban" });
    expect(areaDaRota("/app/leads/xyz")).toEqual({ area: "crm", abaHref: null });
  });
  it("Início não tem abas e rota desconhecida não tem área", () => {
    expect(areaDaRota("/app/inicio")).toEqual({ area: "inicio", abaHref: null });
    expect(areaDaRota("/app/qualquer-coisa")).toBeNull();
  });
  it("viewer não vê aba que leva a 403", () => {
    const { principais, mais } = abasDaArea("organizacao", false, "viewer");
    expect([...principais, ...mais].some((d) => d.href === "/app/settings/api-tokens")).toBe(false);
  });
  it("no máximo 5 abas principais; o resto vai para Mais", () => {
    const { principais, mais } = abasDaArea("ia", false, "admin");
    expect(principais.length).toBeLessThanOrEqual(5);
    expect(mais.length).toBeGreaterThan(0);
  });
  it("área sem nenhuma tela visível some do menu", () => {
    const viewer = areasDoMenu(false, "viewer").map((a) => a.id);
    for (const id of viewer) {
      if (id === "inicio") continue;
      const { principais, mais } = abasDaArea(id, false, "viewer");
      expect(principais.length + mais.length, id).toBeGreaterThan(0);
    }
  });
});
