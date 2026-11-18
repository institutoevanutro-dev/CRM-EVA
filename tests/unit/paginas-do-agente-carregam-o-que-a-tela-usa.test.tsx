/**
 * AS PÁGINAS DO AGENTE CARREGAM O QUE A TELA USA (auditoria de 17/11, lote 1).
 *
 *   9. "Novo agente" não buscava materiais nem funis: as duas seções diziam
 *      "você ainda não cadastrou nenhum" para quem tinha os dois.
 *  11. Gestor (não administrador) via a tela inteira cinza sem explicação.
 *  12. A página baixava o texto inteiro das instruções de TODAS as versões —
 *      até 20 mil caracteres cada — só para desenhar a lista do Histórico.
 *
 * Os server components rodam de verdade, contra um Supabase falso que só
 * devolve as colunas pedidas no `select` — é isso que permite medir o item 12.
 * Os componentes de tela são trocados por gravadores de props. Dados fictícios.
 */
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;
const banco = vi.hoisted(() => ({
  linhas: {} as Record<string, Linha[]>,
  papel: "admin" as string,
}));
const gravado = vi.hoisted(() => ({ form: null as Linha | null, abas: null as Linha | null }));

/** Supabase falso: filtra por `eq`/`in` e devolve só as colunas do `select`. */
function supabaseFalso() {
  return {
    from(tabela: string) {
      let colunas = "*";
      const filtros: Array<(l: Linha) => boolean> = [];
      const executar = () => {
        const linhas = (banco.linhas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
        if (colunas === "*") return linhas;
        const pedidas = colunas
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c && !c.includes("(") && !c.includes(":"));
        return linhas.map((l) => Object.fromEntries(pedidas.filter((c) => c in l).map((c) => [c, l[c]])));
      };
      const q = {
        select(c: string) {
          colunas = c;
          return q;
        },
        eq(k: string, v: unknown) {
          filtros.push((l) => l[k] === v);
          return q;
        },
        in(k: string, v: unknown[]) {
          filtros.push((l) => v.includes(l[k]));
          return q;
        },
        order: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve({ data: executar()[0] ?? null, error: null }),
        then: (ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) =>
          Promise.resolve({ data: executar(), error: null }).then(ok, erro),
      };
      return q;
    },
  };
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: banco.papel }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabaseFalso() }));
vi.mock("@/lib/channels/selectable", () => ({ listSelectableChannels: async () => [] }));
vi.mock("@/lib/instalacao/ambiente", () => ({ lerAmbiente: () => ({ chavesDeProvedor: {} }) }));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentForm", () => ({
  AgentForm: (props: Linha) => {
    gravado.form = props;
    return null;
  },
}));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentTabs", () => ({
  AgentTabs: (props: Linha) => {
    gravado.abas = props;
    return null;
  },
}));
vi.mock("@/app/app/ai/agents/[id]/_components/AgentOperation", () => ({
  AgentOperation: () => null,
}));

import NewAgentPage from "@/app/app/ai/agents/new/page";
import AgentEditorPage from "@/app/app/ai/agents/[id]/page";

const PROMPT_LONGO = "Você é a Clara, recepção de uma clínica fictícia. ".repeat(300);

function versao(numero: number, status: string) {
  return {
    id: `00000000-0000-4000-8000-00000000000${numero}`,
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: numero,
    status,
    system_prompt: `${PROMPT_LONGO} (v${numero})`,
    provider: "anthropic",
    model: "claude-sonnet-5",
    knowledge_source_ids: [],
    pipeline_ids: [],
    created_at: "2026-11-01T00:00:00Z",
  };
}

beforeEach(() => {
  gravado.form = null;
  gravado.abas = null;
  banco.papel = "admin";
  banco.linhas = {
    organizations: [{ id: ORG, settings: {} }],
    ai_provider_credentials_safe: [],
    crm_pipelines: [
      { id: "f1", organization_id: ORG, is_archived: false, name: "Avaliação gratuita", slug: "avaliacao", position: 0, is_default: true },
    ],
    crm_stages: [],
    ai_knowledge_sources: [
      { id: "m1", organization_id: ORG, is_active: true, name: "Tabela de valores", source_type: "text", chunks_count: 4, last_index_status: "ok" },
      { id: "m2", organization_id: ORG, is_active: false, name: "Arquivado", source_type: "text", chunks_count: 1, last_index_status: "ok" },
    ],
    ai_agents: [
      {
        id: AGENTE,
        organization_id: ORG,
        name: "Clara",
        kind: "mcp_agent",
        published_version_id: versao(6, "published").id,
        system_prompt: "",
      },
    ],
    ai_agent_versions: [1, 2, 3, 4, 5].map((n) => versao(n, "superseded")).concat([
      versao(6, "published"),
      versao(7, "draft"),
    ]),
    ai_router_members: [],
  };
});

describe("item 9 — criar agente mostra os materiais e funis que existem", () => {
  it("a página de criação entrega o acervo vivo e os funis ao formulário", async () => {
    render((await NewAgentPage()) as ReactElement);

    const form = gravado.form!;
    expect(form, "o formulário de criação não foi montado").not.toBeNull();
    expect(
      (form.materiais as Linha[] | undefined)?.map((m) => m.name),
      "a seção dizia 'você ainda não cadastrou nenhum material' com material cadastrado",
    ).toEqual(["Tabela de valores"]);
    expect((form.funis as Linha[] | undefined)?.map((f) => f.name)).toEqual(["Avaliação gratuita"]);
    expect(form.cobertura).toHaveProperty("f1");
  });
});

describe("item 11 — gestor sabe por que a tela não deixa editar", () => {
  it("gestor vê a faixa de somente leitura no topo", async () => {
    banco.papel = "manager";
    render((await AgentEditorPage({ params: Promise.resolve({ id: AGENTE }) })) as ReactElement);
    expect(screen.getByTestId("agente-somente-leitura")).toHaveTextContent(
      "Só administradores editam e testam agentes.",
    );
    expect(gravado.abas?.readOnly).toBe(true);
  });

  it("administrador não vê a faixa", async () => {
    render((await AgentEditorPage({ params: Promise.resolve({ id: AGENTE }) })) as ReactElement);
    expect(screen.queryByTestId("agente-somente-leitura")).not.toBeInTheDocument();
  });
});

describe("item 12 — o Histórico não carrega o texto de todas as versões", () => {
  it("a lista vai sem as instruções; só as versões que o editor abre vêm completas", async () => {
    render((await AgentEditorPage({ params: Promise.resolve({ id: AGENTE }) })) as ReactElement);
    const abas = gravado.abas!;

    const lista = abas.versions as Linha[];
    expect(lista).toHaveLength(7);
    expect(
      lista.filter((v) => "system_prompt" in v).map((v) => v.version_number),
      "a página baixava o prompt inteiro de todas as versões",
    ).toEqual([]);

    // O editor continua recebendo o texto completo do que abre.
    expect((abas.draft as Linha).system_prompt).toContain("(v7)");
    expect((abas.published as Linha).system_prompt).toContain("(v6)");
    expect((abas.base as Linha).version_number).toBe(7);
  });
});
