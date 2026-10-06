/**
 * A AGENDA DA RECEPÇÃO DIZ DE QUEM É A JORNADA E QUEM ESTÁ NA BARRA.
 *
 * Porte de melgarafael/DeskcommCRM d7d18345b, 297e7ff5a, 21bbb9a2f e 83f52dd61
 * (issue #896, itens a e 1), adaptado ao papel Prestador deste fork.
 *
 * ─── Os defeitos que esta cerca fecha ────────────────────────────────────
 *
 * (a) O rótulo. A barra de pessoas da Agenda pedia `GET /api/v1/team`, que é
 *     só de gerente. Para a recepção a lista voltava vazia, e o painel de
 *     marcação caía num fallback fixo `{ id: "", nome: "Você" }`: escrevia
 *     "com Você" e "Você ainda não publicou seus horários" sobre a jornada da
 *     MÉDICA, que não estava naquela sessão.
 *
 * (b) A lista. A recepção (e o Prestador) tomava 403 ao abrir a Agenda, com o
 *     aviso genérico "Você não tem permissão para esta ação". Agora há uma lista
 *     mínima — id, papel e nome, sem e-mail — em `GET /api/v1/agenda/pessoas`.
 *     O Prestador recebe só a si mesmo: ele trabalha só na própria agenda.
 *
 *     npx vitest run tests/unit/agenda-do-atendente-diz-por-que.test.tsx
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";

const duble = vi.hoisted(() => ({
  filtros: [] as Array<[string, unknown]>,
  getUrl: [] as string[],
  getResposta: null as unknown,
  avisos: [] as string[],
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const linhas = [
      { user_id: "u-dona", role: "provider" },
      { user_id: "u-recepcao", role: "agent" },
      { user_id: "u-gerente", role: "manager" },
    ];
    const q = {
      select: () => q,
      order: () => q,
      eq: (k: string, v: unknown) => (duble.filtros.push([k, v]), q),
      is: (k: string, v: unknown) => (duble.filtros.push([k, v]), q),
      then: (res: (v: unknown) => unknown) => {
        const quem = duble.filtros.find(([k]) => k === "user_id")?.[1];
        const data = quem ? linhas.filter((l) => l.user_id === quem) : linhas;
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return {
      from: () => q,
      auth: {
        admin: {
          getUserById: (id: string) =>
            Promise.resolve({
              data: { user: { id, email: `${id}@x.com`, user_metadata: { full_name: `Nome ${id}` } } },
            }),
        },
      },
    };
  },
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async (url: string) => {
      duble.getUrl.push(url);
      if (duble.getResposta instanceof Error) throw duble.getResposta;
      return duble.getResposta;
    },
  },
}));
vi.mock("sonner", () => ({
  toast: { warning: (m: string) => duble.avisos.push(m), error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (e: unknown) => duble.avisos.push(`generico:${String(e)}`),
}));

import { PainelDeMarcacao } from "@/components/agenda/PainelDeMarcacao";
import type { Pessoa } from "@/components/agenda/tipos";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { requireRole } from "@/lib/auth/require-role";
import { resolverResponsavelDoPainel } from "@/lib/agenda/responsavel-do-painel";

afterEach(cleanup);

/** Terça, 15 de setembro de 2026, meio-dia — hora de parede do processo. */
const AGORA = new Date("2026-09-15T12:00:00");
const DONA: Pessoa = { id: "dona", nome: "Ana", trilha: 1 };
const RECEPCAO = "recepcao";

describe("(a) 'Você' é de quem está logado, não de quem não deu para listar", () => {
  it("sem a lista da equipe, a jornada da dona NÃO vira 'Você'", () => {
    const pessoa = resolverResponsavelDoPainel({ pessoas: [], donoId: DONA.id, usuarioId: RECEPCAO });

    expect(pessoa.nome).not.toBe("Você");
    expect(pessoa.id).toBe(DONA.id);
  });

  it("a própria agenda continua dizendo 'Você'", () => {
    const pessoa = resolverResponsavelDoPainel({ pessoas: [], donoId: RECEPCAO, usuarioId: RECEPCAO });

    expect(pessoa.nome).toBe("Você");
  });

  it("com a lista em mãos, o nome é o do dono da agenda", () => {
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [DONA, { id: RECEPCAO, nome: "Bruno", trilha: 2 }],
      donoId: DONA.id,
      usuarioId: RECEPCAO,
    });

    expect(pessoa.nome).toBe("Ana");
  });

  it("sem dono definido, a agenda é de quem está logado", () => {
    const pessoa = resolverResponsavelDoPainel({
      pessoas: [DONA, { id: RECEPCAO, nome: "Bruno", trilha: 2 }],
      donoId: null,
      usuarioId: RECEPCAO,
    });

    expect(pessoa.nome).toBe("Você");
  });

  function painelSemJornada(responsavel: Pessoa) {
    render(
      <PainelDeMarcacao
        ancora={AGORA}
        agora={AGORA}
        responsavel={responsavel}
        fuso="America/Sao_Paulo"
        horariosPorDia={{}}
        publicouHorarios={false}
        onConfirmar={vi.fn(async () => undefined)}
      />,
    );
    return screen.getByTestId("sem-jornada-publicada").textContent ?? "";
  }

  it("na agenda da dona, o aviso de jornada não publicada não acusa quem está logado", () => {
    const aviso = painelSemJornada(DONA);

    expect(aviso).toContain("A jornada de atendimento ainda não foi publicada");
    expect(aviso).not.toContain("Você ainda não publicou");
    expect(screen.getByTestId("painel-de-marcacao").textContent).not.toContain("Você ainda");
  });

  it("na própria agenda, o aviso continua na segunda pessoa", () => {
    const aviso = painelSemJornada({ id: RECEPCAO, nome: "Você", trilha: 1 });

    expect(aviso).toContain("Você ainda não publicou seus horários de atendimento");
  });
});

function sessao(papel: Role, id: string) {
  const user = {
    id,
    email: "x@example.com",
    full_name: "X",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: "org-1", organization_name: "Org", role: papel }],
  } as AuthUser;
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: "org-1", name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

async function pedirLista() {
  const { GET } = await import("@/app/api/v1/agenda/pessoas/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/agenda/pessoas"));
  return { status: res.status, corpo: (await res.json()) as { data?: Array<Record<string, unknown>> } };
}

describe("(b) GET /api/v1/agenda/pessoas — a lista mínima da Agenda", () => {
  beforeEach(() => {
    duble.filtros = [];
  });

  it("a recepção lê quem tem agenda: id, papel e nome — sem e-mail", async () => {
    sessao("agent", "u-recepcao");
    const { status, corpo } = await pedirLista();

    expect(status).toBe(200);
    expect(corpo.data?.map((p) => p.user_id)).toEqual(["u-dona", "u-recepcao", "u-gerente"]);
    expect(corpo.data?.[0]).toEqual({ user_id: "u-dona", role: "provider", full_name: "Nome u-dona" });
    expect(JSON.stringify(corpo)).not.toContain("@x.com");
    // organization_id do cookie validado, e revogado fora.
    expect(duble.filtros).toEqual([
      ["organization_id", "org-1"],
      ["revoked_at", null],
    ]);
  });

  it("o Prestador recebe só a si mesmo — ele trabalha só na própria agenda", async () => {
    sessao("provider", "u-dona");
    const { status, corpo } = await pedirLista();

    expect(status).toBe(200);
    expect(corpo.data?.map((p) => p.user_id)).toEqual(["u-dona"]);
  });

  it("quem só lê continua sem a lista", async () => {
    sessao("viewer", "u-leitor");
    const { status } = await pedirLista();

    expect(status).toBe(403);
  });
});

describe("(b) a Agenda pede a lista mínima, e diz por que quando ela não vem", () => {
  const embrulho = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
  };

  beforeEach(() => {
    duble.getUrl = [];
    duble.avisos = [];
  });

  it("a barra de pessoas vem de /api/v1/agenda/pessoas, não da rota da equipe", async () => {
    duble.getResposta = {
      data: [{ user_id: "u-dona", role: "provider", full_name: null }],
    };
    const { result } = renderHook(() => usePessoasDaAgenda(), { wrapper: embrulho() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(duble.getUrl).toEqual(["/api/v1/agenda/pessoas"]);
    expect(result.current.data?.map((p) => p.nome)).toEqual(["Sem nome"]);
  });

  it("o 403 diz de que permissão se trata, e não o aviso genérico", async () => {
    duble.getResposta = new ApiError(403, "forbidden_role", undefined, "req-1", "Requer role >= provider.");
    const { result } = renderHook(() => usePessoasDaAgenda(), { wrapper: embrulho() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(duble.avisos).toHaveLength(1);
    expect(duble.avisos[0]).toContain("Somente leitura");
    expect(duble.avisos[0]).not.toContain("generico:");
  });
});
