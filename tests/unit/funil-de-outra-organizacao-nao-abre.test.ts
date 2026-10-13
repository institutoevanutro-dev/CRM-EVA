/**
 * O FUNIL DE OUTRA ORGANIZAÇÃO É 404, NAS DUAS VISÕES.
 *
 * Quadro e Calendário moram na MESMA página (`/app/pipelines/[id]`): o
 * calendário não tem rota própria. Quem decide se a página abre é o servidor,
 * com a organização da SESSÃO (nunca da URL), e é isso que este teste segura:
 * a consulta do funil filtra pela organização ativa, e sem linha a página é
 * `notFound()`. A RLS é piso, não escopo: quem pertence a duas organizações
 * passaria por ela.
 *
 * Também confere que o fuso entregue à tela é o da organização, já validado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  filtros: [] as Array<[string, string, unknown]>,
  funil: null as { id: string; name: string } | null,
  timezone: "America/Manaus" as string | null,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (para: string) => {
    throw new Error(`REDIRECT:${para}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: async () => ({ id: "u-1" }),
  resolveActiveOrg: async () => ({ orgId: "org-da-sessao", timezone: estado.timezone }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          estado.filtros.push([tabela, coluna, valor]);
          return q;
        },
        order: async () => ({ data: [] }),
        maybeSingle: async () => ({ data: estado.funil }),
      };
      return q;
    },
  }),
}));
vi.mock("@/app/app/pipelines/[id]/_client", () => ({ PipelinePageClient: () => null }));

import PipelinePage from "@/app/app/pipelines/[id]/page";

beforeEach(() => {
  estado.filtros = [];
  estado.funil = null;
  estado.timezone = "America/Manaus";
});

describe("a página do funil", () => {
  it("funil que não é da organização da sessão: 404", async () => {
    await expect(PipelinePage({ params: Promise.resolve({ id: "funil-de-outra-org" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(estado.filtros).toContainEqual(["crm_pipelines", "organization_id", "org-da-sessao"]);
    expect(estado.filtros).toContainEqual(["crm_pipelines", "id", "funil-de-outra-org"]);
  });

  it("funil da organização: abre, com o fuso dela", async () => {
    estado.funil = { id: "p-1", name: "Vendas" };
    const el = (await PipelinePage({ params: Promise.resolve({ id: "p-1" }) })) as {
      props: { pipelineId: string; fuso: string };
    };
    expect(el.props.pipelineId).toBe("p-1");
    expect(el.props.fuso).toBe("America/Manaus");
  });

  it("fuso inválido na coluna (acento, vazio) cai no padrão em vez de derrubar o Intl", async () => {
    estado.funil = { id: "p-1", name: "Vendas" };
    for (const ruim of ["America/Asunción", "", null]) {
      estado.timezone = ruim;
      const el = (await PipelinePage({ params: Promise.resolve({ id: "p-1" }) })) as {
        props: { fuso: string };
      };
      expect(el.props.fuso).toBe("America/Sao_Paulo");
    }
  });
});
