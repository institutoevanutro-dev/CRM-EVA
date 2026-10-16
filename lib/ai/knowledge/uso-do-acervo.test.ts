import { describe, expect, it, vi } from "vitest";

import { carregarUsoDoAcervo, usoDoAcervo, type AgenteDoAcervo } from "./uso-do-acervo";

const FAQ = "11111111-1111-4111-8111-111111111111";
const PRECOS = "22222222-2222-4222-8222-222222222222";
const ORFAO = "33333333-3333-4333-8333-333333333333";

const agente = (id: string, nome: string, materiais: string[], noAr = true): AgenteDoAcervo => ({
  id,
  nome,
  noAr,
  materiais,
});

describe("usoDoAcervo", () => {
  const agentes = [
    agente("a1", "Agendamento", [FAQ, PRECOS]),
    agente("a2", "Dúvidas", [FAQ]),
    agente("a3", "Antigo", [FAQ], false),
  ];

  it("quem consultou sai das buscas, com a última consulta", () => {
    const uso = usoDoAcervo(agentes, [
      { agent_id: "a1", knowledge_source_ids: [FAQ, PRECOS], created_at: "2026-10-15T10:00:00Z" },
      { agent_id: "a2", knowledge_source_ids: [FAQ], created_at: "2026-10-16T09:00:00Z" },
      { agent_id: "a1", knowledge_source_ids: [PRECOS], created_at: "2026-10-14T08:00:00Z" },
    ]);
    expect(uso[FAQ]).toEqual({
      consultadoPor: ["Agendamento", "Dúvidas"],
      todos: true,
      ultimaConsultaEm: "2026-10-16T09:00:00Z",
      disponivelPara: ["Agendamento", "Dúvidas"],
    });
    expect(uso[PRECOS]).toMatchObject({
      consultadoPor: ["Agendamento"],
      todos: false,
      ultimaConsultaEm: "2026-10-15T10:00:00Z",
      disponivelPara: ["Agendamento"],
    });
  });

  it("material que ninguém consultou na janela continua dizendo quem pode", () => {
    const uso = usoDoAcervo(agentes, []);
    expect(uso[PRECOS]).toEqual({
      consultadoPor: [],
      todos: false,
      ultimaConsultaEm: null,
      disponivelPara: ["Agendamento"],
    });
    // Nem lido, nem consultado: não aparece (o cartão trata como órfão).
    expect(uso[ORFAO]).toBeUndefined();
  });

  it("assistente fora do ar não tira o 'todos', mas aparece se consultou", () => {
    const uso = usoDoAcervo(agentes, [
      { agent_id: "a1", knowledge_source_ids: [FAQ], created_at: "2026-10-15T10:00:00Z" },
      { agent_id: "a2", knowledge_source_ids: [FAQ], created_at: "2026-10-15T11:00:00Z" },
      { agent_id: "a3", knowledge_source_ids: [FAQ], created_at: "2026-10-15T12:00:00Z" },
    ]);
    expect(uso[FAQ]?.todos).toBe(true);
    expect(uso[FAQ]?.consultadoPor).toEqual(["Agendamento", "Antigo", "Dúvidas"]);
  });

  it("busca sem agente (anterior à 0181) conta para a data, não para o nome", () => {
    const uso = usoDoAcervo(agentes, [
      { agent_id: null, knowledge_source_ids: [FAQ], created_at: "2026-10-16T12:00:00Z" },
    ]);
    expect(uso[FAQ]).toMatchObject({ consultadoPor: [], ultimaConsultaEm: "2026-10-16T12:00:00Z" });
  });

  it("um assistente só nunca vira 'todos'", () => {
    const uso = usoDoAcervo([agente("a1", "Único", [FAQ])], [
      { agent_id: "a1", knowledge_source_ids: [FAQ], created_at: "2026-10-16T12:00:00Z" },
    ]);
    expect(uso[FAQ]).toMatchObject({ consultadoPor: ["Único"], todos: false });
  });
});

describe("carregarUsoDoAcervo", () => {
  function cliente(respostas: Record<string, { data: unknown; error: unknown }>) {
    const pedidos: Array<{ tabela: string; select: string; filtros: Array<[string, unknown]> }> = [];
    const client = {
      from(tabela: string) {
        const pedido = { tabela, select: "", filtros: [] as Array<[string, unknown]> };
        pedidos.push(pedido);
        const q = {
          select: (s: string) => ((pedido.select = s), q),
          eq: (c: string, v: unknown) => (pedido.filtros.push([c, v]), q),
          gte: (c: string, v: unknown) => (pedido.filtros.push([`${c}>=`, v]), q),
          order: () => q,
          limit: () => q,
          then: (res: (v: unknown) => unknown) => res(respostas[tabela]),
        };
        return q;
      },
    };
    return { client: client as never, pedidos };
  }

  it("nomeia a chave do embed e filtra a organização nas duas leituras", async () => {
    const { client, pedidos } = cliente({
      ai_agents: {
        data: [
          { id: "a1", name: "Agendamento", archived_at: null, versao: { knowledge_source_ids: [FAQ] } },
          { id: "a2", name: "Rascunho", archived_at: null, versao: null },
        ],
        error: null,
      },
      knowledge_searches: {
        data: [{ agent_id: "a1", knowledge_source_ids: [FAQ], created_at: "2026-10-16T09:00:00Z" }],
        error: null,
      },
    });
    const uso = await carregarUsoDoAcervo(client, "org-1", new Date("2026-10-16T12:00:00Z"));

    expect(pedidos.find((p) => p.tabela === "ai_agents")?.select).toContain(
      "ai_agent_versions!ai_agents_published_version_id_fkey(",
    );
    for (const p of pedidos) expect(p.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(pedidos.find((p) => p.tabela === "knowledge_searches")?.filtros).toContainEqual([
      "created_at>=",
      "2026-09-16T12:00:00.000Z",
    ]);
    expect(uso?.[FAQ]).toMatchObject({ consultadoPor: ["Agendamento"], disponivelPara: ["Agendamento"] });
  });

  it("erro de leitura devolve null, nunca 'ninguém consulta'", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = cliente({
      ai_agents: { data: null, error: { code: "PGRST201", message: "more than one relationship" } },
      knowledge_searches: { data: [], error: null },
    });
    expect(await carregarUsoDoAcervo(client, "org-1")).toBeNull();
    aviso.mockRestore();
  });
});
