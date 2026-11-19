/**
 * O menu lateral agrupa as telas pelo que a pessoa veio fazer (lib/navigation/menu.ts), numa camada
 * por cima do catálogo. O risco dessa camada é uma tela nova do catálogo não entrar em grupo nenhum
 * e sumir do menu sem ninguém perceber: este arquivo é a cerca.
 */
import { describe, expect, it } from "vitest";

import { FORA_DO_MENU, MENU, atalhosDoMenu, MINHA_CONTA, gruposDoMenu, ondeNoMenu, telasDaConta, veInicio } from "@/lib/navigation/menu";
import { NAV_DESTINATIONS, hubSections, searchable } from "@/lib/navigation/registry";

const noMenu = MENU.flatMap((g) => g.hrefs);
const todos = [...noMenu, ...MINHA_CONTA, ...FORA_DO_MENU, "/app/inicio"];

describe("menu por tarefa", () => {
  it("toda tela do catálogo está em UM lugar: num grupo, em Minha conta, fora do menu, ou é o Início", () => {
    const catalogo = NAV_DESTINATIONS.map((d) => d.href).sort();
    expect([...todos].sort()).toEqual(catalogo);
    expect(new Set(todos).size).toBe(todos.length);
  });

  it("nenhum grupo passa de 9 telas (é o que permite mostrar todas, sem \"Ver tudo\")", () => {
    for (const g of MENU) expect(g.hrefs.length, g.label).toBeLessThanOrEqual(9);
    expect(MENU.map((g) => `${g.label} ${g.hrefs.length}`)).toEqual([
      "Atendimento 7", "Vendas 5", "Assistente 8", "Análise 9", "Clínica 9", "Integrações 7",
    ]);
  });

  it("admin vê os seis grupos, na ordem de uso, com todas as telas de cada um", () => {
    const g = gruposDoMenu(false, "admin");
    expect(g.map((x) => x.label)).toEqual(["Atendimento", "Vendas", "Assistente", "Análise", "Clínica", "Integrações"]);
    expect(g.find((x) => x.id === "clinica")!.itens.map((d) => d.label)).toEqual([
      "Equipe", "Distribuição de atendimento", "Etiquetas", "Tipos de agendamento", "Etapas do funil", "Marca", "Organização", "Produtos", "LGPD",
    ]);
  });

  it("o papel continua mandando: quem só lê não vê Assistente nem Integrações, e Atendimento vem sem Casos", () => {
    const g = gruposDoMenu(false, "viewer");
    expect(g.map((x) => x.id)).not.toContain("assistente");
    expect(g.map((x) => x.id)).not.toContain("integracoes");
    expect(g.find((x) => x.id === "atendimento")!.itens.map((d) => d.label)).toEqual(["Conversas", "Radar", "Agenda", "Respostas rápidas", "Central de avisos", "Propostas"]);
    expect(veInicio(false, "viewer")).toBe(true);
  });

  it("Campanhas só para gerente: a API delas só responde a gerente (item 232)", () => {
    const vendas = (role: "agent" | "manager") => gruposDoMenu(false, role).find((x) => x.id === "vendas")!.itens.map((d) => d.href);
    expect(vendas("agent")).not.toContain("/app/campaigns");
    expect(vendas("manager")).toContain("/app/campaigns");
  });

  it("a página de Configurações respeita o que saiu do menu, e a busca continua achando (item 231)", () => {
    const hub = hubSections("organizacao", false, "admin").flatMap((s) => s.items.map((i) => i.href));
    for (const h of FORA_DO_MENU) expect(hub).not.toContain(h);
    const busca = searchable(false, "admin").map((d) => d.href);
    for (const h of FORA_DO_MENU) expect(busca).toContain(h);
  });

  it("recolhido, os atalhos do dia seguem o papel (item 228)", () => {
    expect(atalhosDoMenu(false, "admin").map((d) => d.href)).toEqual(["/app/agenda", "/app/inbox", "/app/contacts", "/app/ai/inbox"]);
  });

  it("Minha conta abre Perfil, Segurança e Notificações, e não está em grupo nenhum", () => {
    expect(telasDaConta(false, "agent").map((d) => d.label)).toEqual(["Perfil", "Segurança", "Notificações"]);
    expect(ondeNoMenu("/app/settings/security")).toEqual({ grupo: null, href: "/app/settings/security" });
  });

  it("a rota diz o grupo: tela movida, tela de detalhe e tela fora do catálogo", () => {
    expect(ondeNoMenu("/app/inicio").grupo).toBe("inicio");
    expect(ondeNoMenu("/app/ai/inbox")).toEqual({ grupo: "atendimento", href: "/app/ai/inbox" });
    expect(ondeNoMenu("/app/products").grupo).toBe("clinica");
    expect(ondeNoMenu("/app/ai/usage").grupo).toBe("analise");
    expect(ondeNoMenu("/app/ai/credentials").grupo).toBe("integracoes");
    expect(ondeNoMenu("/app/pipelines/abc")).toEqual({ grupo: "vendas", href: "/app/kanban" });
    expect(ondeNoMenu("/app/leads/abc").grupo).toBe("vendas");
    expect(ondeNoMenu("/app/settings/atualizacao").grupo).toBe("clinica");
    // Configurações tem porta própria no rodapé; nas páginas de área nenhum grupo abre.
    expect(ondeNoMenu("/app/settings")).toEqual({ grupo: "configuracoes", href: null });
    expect(ondeNoMenu("/app/ai")).toEqual({ grupo: null, href: null });
  });
});
