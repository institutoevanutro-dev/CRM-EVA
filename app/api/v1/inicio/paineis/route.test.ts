/**
 * GET /api/v1/inicio/paineis — só gestor; cada painel isolado (spec 2026-10-07-inicio-paineis).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "./route";

// Leitura solta do JSON nos testes: o contrato fino é provado campo a campo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Paineis = Record<string, any>;

const FUNIS = [
  { id: "f2", name: "Outro", is_default: false },
  { id: "f1", name: "Pedidos", is_default: true },
];
const RPC: Record<string, { data: unknown; error: unknown }> = {};
const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];

function dbFalso() {
  return {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      return RPC[fn] ?? { data: null, error: { message: "não configurado" } };
    }),
    from: vi.fn(() => {
      const q = {
        select: () => q,
        eq: () => q,
        order: async () => ({ data: FUNIS, error: null }),
      };
      return q;
    }),
  };
}

function comoGestor() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1", timezone: null, idioma: "pt-BR" },
    org: { orgId: "org-1", role: "manager", timezone: "America/Sao_Paulo" },
  } as never);
}

async function chamar(url = "http://localhost/api/v1/inicio/paineis") {
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(url));
}

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
  vi.mocked(createClient).mockResolvedValue(dbFalso() as never);
  RPC.fn_inicio_conversas_por_dia = {
    data: [{ dia: "2026-10-01", ia_sozinha: 2, com_equipe: 1, sem_resposta: 0, soma_primeira_resposta_s: 300, respondidas: 3 }],
    error: null,
  };
  RPC.fn_inicio_agenda = {
    data: [{ unit_id: "u", unidade: "Vitória", marcadas: 3, confirmadas: 1, realizadas: 2, faltas: 1, canceladas: 0 }],
    error: null,
  };
  RPC.fn_inicio_funil = {
    data: { etapas: [{ id: "e1", nome: "Avaliação", abertos: 2 }], mes: { ganhos: 1, perdidos: 0, valor: { BRL: "15000" } }, anterior: { ganhos: 0, perdidos: 1, valor: {} } },
    error: null,
  };
  RPC.fn_inicio_origem = {
    data: [
      { origem: "meta_ads", utm_source: null, total: 4 },
      { origem: "webhook", utm_source: "site", total: 2 },
      { origem: "webhook", utm_source: null, total: 1 },
    ],
    error: null,
  };
});

describe("GET /api/v1/inicio/paineis", () => {
  it("quem não é gestor recebe a resposta do requireRole (403)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  it("gestor recebe os quatro painéis montados", async () => {
    comoGestor();
    const res = await chamar();
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: Paineis }).data;
    expect(d.conversas.ok).toBe(true);
    expect(d.conversas.dias).toHaveLength(30);
    expect(d.conversas.primeiraRespostaMediaS).toBe(100);
    expect(d.agenda.unidades[0]).toMatchObject({ unidade: "Vitória", comparecimento: 2 / 3 });
    expect(d.funil).toMatchObject({ ok: true, funilId: "f1", funis: [{ id: "f2" }, { id: "f1" }] });
    expect(d.origem.itens[0]).toEqual({ origem: "anuncio_meta", rotulo: "Anúncio do Meta", total: 4, detalhes: [] });
    expect(d.origem.itens[1]).toMatchObject({ origem: "formulario", total: 3, detalhes: [{ utm: "site", total: 2 }] });
    expect(chamadas.find((c) => c.fn === "fn_inicio_conversas_por_dia")!.args.p_fuso).toBe("America/Sao_Paulo");
  });

  it("um painel com erro vira {ok:false} sem derrubar os outros", async () => {
    comoGestor();
    RPC.fn_inicio_agenda = { data: null, error: { message: "boom" } };
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.agenda).toEqual({ ok: false });
    expect(d.conversas.ok).toBe(true);
  });

  it("?funil= de um funil que não existe usa o padrão", async () => {
    comoGestor();
    await chamar("http://localhost/api/v1/inicio/paineis?funil=nao-existe");
    expect(chamadas.find((c) => c.fn === "fn_inicio_funil")!.args.p_pipeline).toBe("f1");
  });

  it("sem funil ativo, o painel diz isso em vez de falhar", async () => {
    comoGestor();
    FUNIS.splice(0, FUNIS.length);
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.funil).toEqual({ ok: true, semFunil: true, funis: [] });
    FUNIS.push({ id: "f2", name: "Outro", is_default: false }, { id: "f1", name: "Pedidos", is_default: true });
  });
});
