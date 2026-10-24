import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

/** Os placares lado a lado são do APROVADOR (uma pessoa), não de quem é admin. */

const ids = vi.hoisted(() => ({ APROVADOR: "11111111-1111-4111-8111-111111111111", A: "22222222-2222-4222-8222-222222222222" }));
const { APROVADOR, A } = ids;
const estado = vi.hoisted(() => ({ quemPede: "" }));
const banco = vi.hoisted(() => ({ atual: null as null | ReturnType<typeof supabaseEmMemoria> }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: estado.quemPede, idioma: "pt-BR" }, org: { orgId: "org-a", role: "admin" } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => banco.atual!.cliente }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map([[ids.A, "Pessoa A"]]) }));
vi.mock("@/lib/bonus/fatos", async () => {
  const { regrasSchema } = await import("@/lib/bonus/regras");
  const regras = regrasSchema.parse({ participantes: [ids.A], tarefas: { valor_cents: 20_000 } });
  return {
    lerPrograma: async () => ({
      status: "ok",
      programa: { id: "prog", organizationId: "org-a", aprovadorUserId: ids.APROVADOR, ativo: true, regras, fuso: "America/Sao_Paulo", etapasDeSinalPago: [] },
    }),
    fatosDoMes: async (_a: unknown, _p: unknown, mes: string, hoje: string) => ({
      mes,
      hoje,
      regras,
      pessoas: [{ userId: ids.A, tarefas: [], leads: [], ligacoes: [], diasDeExcecao: [] }],
      storiesPorDia: {},
      resultados: { comparecimento: 0, sinal_pago: 0, avaliacao_google: null },
    }),
    historicoDeEnvioRecente: async () => [],
  };
});

import { GET } from "./route";

const get = () => GET(new NextRequest("http://localhost/api/v1/bonus/equipe?mes=2026-11"));

describe("GET /api/v1/bonus/equipe", () => {
  it("admin participante que não é o aprovador: 403", async () => {
    banco.atual = supabaseEmMemoria({});
    estado.quemPede = A;
    expect((await get()).status).toBe(403);
  });

  it("o aprovador vê os placares, com a contagem de stories da linha de hoje", async () => {
    banco.atual = supabaseEmMemoria({});
    estado.quemPede = APROVADOR;
    const res = await get();
    expect(res.status).toBe(200);
    const corpo = (await res.json()).data;
    expect(corpo.mes).toBe("2026-11");
    expect(corpo.nomes).toEqual({ [A]: "Pessoa A" });
    expect(corpo.placar.pessoas.map((p: { userId: string }) => p.userId)).toEqual([A]);
    expect(corpo.stories_hoje).toEqual({ contagem: 0, leitura_erro: null });
    expect(corpo.fila_reduzida_hoje).toBe(false);
  });

  it("stories de hoje: a contagem manual vence, e a linha de outra organização não entra", async () => {
    const hoje = diaLocalISO(new Date(), "America/Sao_Paulo");
    banco.atual = supabaseEmMemoria({
      bonus_stories_dia: [
        { organization_id: "org-b", dia: hoje, story_ids: ["x", "y", "z", "w"], contagem_manual: null, leitura_erro: "sem_permissao" },
        { organization_id: "org-a", dia: hoje, story_ids: ["s1"], contagem_manual: 3, leitura_erro: null },
      ],
    });
    estado.quemPede = APROVADOR;
    const corpo = (await (await get()).json()).data;
    expect(corpo.stories_hoje).toEqual({ contagem: 3, leitura_erro: null });
  });
});
