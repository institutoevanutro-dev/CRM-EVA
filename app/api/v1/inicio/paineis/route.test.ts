/**
 * GET /api/v1/inicio/paineis — só gestor; cada painel isolado (specs 2026-10-07-inicio-paineis e 2026-11-11-inicio-claro).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map([["p1", "Dra. Exemplo"]])),
}));

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
  RPC.fn_inicio_atendimento = {
    data: { ia_sozinha: 38, com_equipe: 55, sem_resposta: 7, mediana_primeira_resposta_s: 42.5 },
    error: null,
  };
  RPC.fn_inicio_esperando = {
    data: {
      ve_sem_responsavel: true,
      recentes: { total: 12, com_voce: 1, sem_responsavel: 5 },
      antigas: { total: 40, com_voce: 0, sem_responsavel: 31 },
      itens: [{ id: "c1", desde: "2026-10-01T10:00:00Z", name: null, display_name: "Fulana", phone_number: null }],
    },
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
  RPC.fn_inicio_resumo_da_clinica = {
    data: {
      profissionais: [
        { user_id: "p1", hoje: 3, semana: 9, realizadas: 4, faltas: 1, canceladas: 0, minutos: 540 },
        { user_id: null, hoje: 1, semana: 1, realizadas: 0, faltas: 0, canceladas: 0, minutos: 60 },
      ],
      vendas: { novos_mes: 12, novos_anterior: 8, ganhos_mes: 3, perdidos_mes: 2, valor: { BRL: "150000" } },
    },
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

  it("gestor recebe os painéis montados", async () => {
    comoGestor();
    const res = await chamar();
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: Paineis }).data;
    expect(d.agenda.unidades[0]).toMatchObject({ unidade: "Vitória", comparecimento: 2 / 3 });
    // Do funil saem só as etapas: ganhos e valor DESTE funil não vão à tela (as vendas somam todos).
    expect(d.funil).toEqual({ ok: true, funilId: "f1", funis: [{ id: "f2", nome: "Outro" }, { id: "f1", nome: "Pedidos" }], etapas: [{ id: "e1", nome: "Avaliação", abertos: 2 }] });
    expect(d.origem.itens[0]).toEqual({ origem: "anuncio_meta", rotulo: "Anúncio do Meta", total: 4, detalhes: [] });
    expect(d.origem.itens[1]).toMatchObject({ origem: "formulario", total: 3, detalhes: [{ utm: "site", total: 2 }] });
    // O nome do mês sai destes dois dias; a tela o escreve no idioma de quem lê.
    expect(d.periodo.mes).toMatch(/^\d{4}-\d{2}-01$/);
    expect(d.periodo.mesAnterior).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("atendimento: as três faixas, a frase 'de cada 10' somando 10 e a MEDIANA da primeira resposta", async () => {
    comoGestor();
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.atendimento).toEqual({
      ok: true,
      equipe: 55,
      ia: 38,
      semResposta: 7,
      deCadaDez: { equipe: 5, ia: 4, semResposta: 1 },
      medianaPrimeiraRespostaS: 42.5,
    });
    expect(Object.keys(chamadas.find((c) => c.fn === "fn_inicio_atendimento")!.args).sort()).toEqual(["p_fim", "p_inicio", "p_org"]);
  });

  it("esperando agora: a clínica toda, pela mesma função e o mesmo corte de 3 dias do Meu dia", async () => {
    comoGestor();
    const antes = Date.now();
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.esperando).toEqual({ ok: true, recentes: 12, semResponsavel: 5, antigas: 40 });
    const args = chamadas.find((c) => c.fn === "fn_inicio_esperando")!.args;
    expect(args.p_org).toBe("org-1");
    const corte = Date.parse(String(args.p_corte));
    const tresDias = 3 * 24 * 60 * 60 * 1000;
    expect(corte).toBeGreaterThanOrEqual(antes - tresDias);
    expect(corte).toBeLessThanOrEqual(Date.now() - tresDias);
  });

  it("resumo da clínica: profissionais com nome e vendas de todos os funis; o mês anterior vai só até os mesmos dias", async () => {
    comoGestor();
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.resumo.ok).toBe(true);
    expect(d.resumo.profissionais[0]).toMatchObject({ user_id: "p1", nome: "Dra. Exemplo", hoje: 3 });
    expect(d.resumo.profissionais[1]).toMatchObject({ user_id: null, nome: null });
    expect(d.resumo.vendas).toEqual({ novos_mes: 12, novos_anterior: 8, ganhos_mes: 3, perdidos_mes: 2, valor: { BRL: "150000" } });
    const args = chamadas.find((c) => c.fn === "fn_inicio_resumo_da_clinica")!.args;
    expect(args.p_org).toBe("org-1");
    expect(Object.keys(args).sort()).toEqual(
      ["p_ant_fim", "p_ant_inicio", "p_hoje_fim", "p_hoje_inicio", "p_mes_fim", "p_mes_inicio", "p_org", "p_semana_fim", "p_semana_inicio"],
    );
    // Nunca o mês anterior inteiro: a janela de comparação fecha antes do começo deste mês
    // (ou nele, nos últimos dias de um mês mais longo que o anterior).
    expect(Date.parse(String(args.p_ant_fim))).toBeLessThanOrEqual(Date.parse(String(args.p_mes_inicio)));
    expect(Date.parse(String(args.p_ant_fim))).toBeGreaterThanOrEqual(Date.parse(String(args.p_ant_inicio)));
  });

  it("um painel com erro vira {ok:false} sem derrubar os outros", async () => {
    comoGestor();
    RPC.fn_inicio_agenda = { data: null, error: { message: "boom" } };
    const d = ((await (await chamar()).json()) as { data: Paineis }).data;
    expect(d.agenda).toEqual({ ok: false });
    expect(d.atendimento.ok).toBe(true);
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
