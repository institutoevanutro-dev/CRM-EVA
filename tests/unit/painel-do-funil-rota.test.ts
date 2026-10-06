/**
 * GET /api/v1/metrics/funil — papel, Zod, escopo de organização e corte
 * (passo 10 do plano `docs/superpowers/plans/2026-10-06-painel-do-funil.md`).
 *
 * O dublê do banco é uma TABELINHA que aplica os predicados (`eq`, `in`, `gte`,
 * `lt`) e o teto `max_rows = 1000` do PostgREST — mesma régua de
 * `reports-por-etiqueta.test.ts`: gravar só a chamada provaria que o filtro foi
 * escrito, não que ele tirou a linha do vizinho.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  investimento: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.requireRole }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.createAdminClient }));
vi.mock("@/lib/plataformas-de-anuncio/meta/investimento", () => ({
  investimentoDoPeriodo: m.investimento,
}));

import { GET } from "@/app/api/v1/metrics/funil/route";
import { DICIONARIO } from "@/lib/i18n/dicionario";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const P_OUTRA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Linha = Record<string, unknown>;
let banco: Record<string, Linha[]>;
let consultas: Array<{ tabela: string; filtros: Array<[string, string, unknown]> }>;
let erroEm: string | null;

const MAX_ROWS = 1000;

function casa(valor: unknown, op: string, alvo: unknown): boolean {
  if (op === "eq") return valor === alvo;
  if (op === "in") return (alvo as unknown[]).includes(valor);
  const a = Date.parse(String(valor));
  const b = Date.parse(String(alvo));
  return op === "gte" ? a >= b : a < b;
}

function clientFalso() {
  return {
    from(tabela: string) {
      const filtros: Array<[string, string, unknown]> = [];
      consultas.push({ tabela, filtros });
      let faixa: [number, number] | null = null;
      let contar = false;
      const resolver = () => {
        if (erroEm === tabela) return { data: null, error: { message: "falhou" }, count: null };
        const todas = (banco[tabela] ?? []).filter((l) =>
          filtros.every(([c, op, v]) => casa(l[c], op, v)),
        );
        const [de, ate] = faixa ?? [0, todas.length - 1];
        return {
          data: todas.slice(de, Math.min(ate + 1, de + MAX_ROWS)),
          error: null,
          count: contar ? todas.length : null,
        };
      };
      const cadeia = {
        select(_c: string, opts?: { count?: string }) {
          contar = opts?.count === "exact";
          return cadeia;
        },
        eq(c: string, v: unknown) {
          filtros.push([c, "eq", v]);
          return cadeia;
        },
        in(c: string, v: unknown[]) {
          filtros.push([c, "in", v]);
          return cadeia;
        },
        gte(c: string, v: unknown) {
          filtros.push([c, "gte", v]);
          return cadeia;
        },
        lt(c: string, v: unknown) {
          filtros.push([c, "lt", v]);
          return cadeia;
        },
        order() {
          return cadeia;
        },
        range(de: number, ate: number) {
          faixa = [de, ate];
          return Promise.resolve(resolver());
        },
        then<T>(ok: (v: ReturnType<typeof resolver>) => T) {
          return Promise.resolve(resolver()).then(ok);
        },
      };
      return cadeia;
    },
  };
}

const CAMPOS = [
  {
    key: "modalidade",
    label: "Modalidade",
    type: "select",
    options: [
      { value: "online", label: "Online" },
      { value: "presencial", label: "Presencial" },
    ],
  },
  {
    key: "origem",
    label: "Origem",
    type: "select",
    options: [
      { value: "instagram", label: "Instagram" },
      { value: "indicacao", label: "Indicação" },
    ],
  },
  { key: "obs", label: "Observação", type: "text" },
];

const NO_PERIODO = "2026-09-10T15:00:00.000Z";
const ANTES = "2026-07-01T15:00:00.000Z";

function semear() {
  banco = {
    crm_pipelines: [
      {
        id: P,
        organization_id: ORG,
        name: "Comercial",
        is_default: true,
        is_archived: false,
        position: 1,
        settings: { fields: CAMPOS },
      },
      {
        id: P2,
        organization_id: ORG,
        name: "Acompanhamento",
        is_default: false,
        is_archived: false,
        position: 2,
        settings: { fields: [] },
      },
      {
        id: P_OUTRA,
        organization_id: OUTRA,
        name: "Do vizinho",
        is_default: true,
        is_archived: false,
        position: 1,
        settings: {},
      },
    ],
    crm_stages: [
      {
        id: "s-novo",
        organization_id: ORG,
        pipeline_id: P,
        name: "Novo",
        position: 10,
        is_won: false,
        is_lost: false,
        is_archived: false,
        agent_stage_hint: null,
      },
      {
        id: "s-int",
        organization_id: ORG,
        pipeline_id: P,
        name: "Interagiu",
        position: 20,
        is_won: false,
        is_lost: false,
        is_archived: false,
        agent_stage_hint: "contacted",
      },
      {
        id: "s-ganho",
        organization_id: ORG,
        pipeline_id: P,
        name: "Ganho",
        position: 40,
        is_won: true,
        is_lost: false,
        is_archived: false,
        agent_stage_hint: null,
      },
    ],
    crm_leads: [
      {
        id: "L1",
        organization_id: ORG,
        pipeline_id: P,
        stage_id: "s-novo",
        status: "open",
        contact_id: "C1",
        custom_fields: { modalidade: "online" },
        value_cents: null,
        currency: "BRL",
        created_at: NO_PERIODO,
        closed_at: null,
      },
      {
        id: "L2",
        organization_id: ORG,
        pipeline_id: P,
        stage_id: "s-int",
        status: "open",
        contact_id: "C2",
        custom_fields: { modalidade: "TEXTO-LIVRE-SECRETO" },
        value_cents: null,
        currency: "BRL",
        created_at: NO_PERIODO,
        closed_at: null,
      },
      {
        id: "L3",
        organization_id: ORG,
        pipeline_id: P,
        stage_id: "s-ganho",
        status: "won",
        contact_id: "C1",
        custom_fields: { modalidade: "presencial" },
        value_cents: 50000,
        currency: "BRL",
        created_at: ANTES,
        closed_at: NO_PERIODO,
      },
      // Cards da MESMA org no OUTRO funil: só o filtro de funil os tira de P.
      // Valor alto de propósito — se vazar, a receita de P muda.
      {
        id: "L-P2",
        organization_id: ORG,
        pipeline_id: P2,
        stage_id: "s-p2",
        status: "won",
        contact_id: "C1",
        custom_fields: {},
        value_cents: 777700,
        currency: "BRL",
        created_at: NO_PERIODO,
        closed_at: NO_PERIODO,
      },
      {
        id: "L-P2b",
        organization_id: ORG,
        pipeline_id: P2,
        stage_id: "s-p2",
        status: "open",
        contact_id: "C3",
        custom_fields: {},
        value_cents: null,
        currency: "BRL",
        created_at: NO_PERIODO,
        closed_at: null,
      },
      // O vizinho com o MESMO funil no payload: só o filtro de org o tira.
      {
        id: "L-VIZ",
        organization_id: OUTRA,
        pipeline_id: P,
        stage_id: "s-novo",
        status: "won",
        contact_id: "C-VIZ",
        custom_fields: {},
        value_cents: 999900,
        currency: "BRL",
        created_at: NO_PERIODO,
        closed_at: NO_PERIODO,
      },
    ],
    crm_lead_activities: [
      {
        id: "a1",
        organization_id: ORG,
        lead_id: "L2",
        type: "stage_changed",
        payload: { from_stage_id: "s-novo", to_stage_id: "s-int" },
        performed_at: NO_PERIODO,
      },
      {
        id: "a-viz",
        organization_id: OUTRA,
        lead_id: "L1",
        type: "stage_changed",
        payload: { de: "s-novo", para: "s-ganho" },
        performed_at: NO_PERIODO,
      },
    ],
    calendar_appointments: [
      {
        id: "A1",
        organization_id: ORG,
        contact_id: "C1",
        status: "completed",
        starts_at: NO_PERIODO,
        ends_at: NO_PERIODO,
      },
      {
        id: "A2",
        organization_id: ORG,
        contact_id: "C2",
        status: "no_show",
        starts_at: NO_PERIODO,
        ends_at: NO_PERIODO,
      },
      // Vinculado SÓ a card do funil P2: não é agenda de P.
      {
        id: "A3",
        organization_id: ORG,
        contact_id: "C1",
        status: "completed",
        starts_at: NO_PERIODO,
        ends_at: NO_PERIODO,
      },
      // Sem vínculo, e o contato só tem card em P2: não é agenda de P.
      {
        id: "A4",
        organization_id: ORG,
        contact_id: "C3",
        status: "confirmed",
        starts_at: NO_PERIODO,
        ends_at: NO_PERIODO,
      },
      {
        id: "A-VIZ",
        organization_id: OUTRA,
        contact_id: "C1",
        status: "completed",
        starts_at: NO_PERIODO,
        ends_at: NO_PERIODO,
      },
    ],
    crm_lead_links: [
      {
        id: "k1",
        organization_id: ORG,
        lead_id: "L1",
        target_kind: "appointment",
        target_id: "A1",
        created_at: NO_PERIODO,
      },
      {
        id: "k-p2",
        organization_id: ORG,
        lead_id: "L-P2",
        target_kind: "appointment",
        target_id: "A3",
        created_at: NO_PERIODO,
      },
    ],
    contacts: [
      {
        id: "C1",
        organization_id: ORG,
        custom_fields: { origem: "instagram" },
        tags: ["Criativo-A"],
        is_anonymized: false,
        source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "900001" } },
      },
      {
        id: "C2",
        organization_id: ORG,
        custom_fields: {},
        tags: [],
        is_anonymized: false,
        source_metadata: {},
      },
      {
        id: "C3",
        organization_id: ORG,
        custom_fields: {},
        tags: [],
        is_anonymized: false,
        source_metadata: {},
      },
    ],
  };
}

const INVESTIMENTO_OK = {
  estado: "ok",
  conta: { id: "act_1", nome: "Conta principal" },
  moeda: "BRL",
  cents: 10000,
  porCampanha: new Map([["120300001", { nome: "Setembro", cents: 10000 }]]),
  campanhaPorAnuncio: new Map([["900001", "120300001"]]),
};

function autorizar(idioma = "pt-BR") {
  m.requireRole.mockResolvedValue({
    ok: true,
    user: { id: "u1", idioma, is_platform_admin: false },
    org: { orgId: ORG, name: "Org", role: "manager", timezone: "America/Sao_Paulo" },
  });
}

const chamar = async (qs = "de=2026-09-01&ate=2026-09-30") => {
  const r = await GET(new NextRequest(`http://localhost/api/v1/metrics/funil?${qs}`));
  // O corpo é JSON navegado por caminho nas asserções; tipá-lo inteiro repetiria o hook.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, corpo: (await r.json()) as Record<string, any> };
};

beforeEach(() => {
  vi.clearAllMocks();
  semear();
  consultas = [];
  erroEm = null;
  autorizar();
  m.createClient.mockImplementation(async () => clientFalso());
  m.createAdminClient.mockReturnValue({});
  m.investimento.mockResolvedValue(INVESTIMENTO_OK);
});

describe("papel", () => {
  it("negado devolve a resposta do requireRole e não lê nada", async () => {
    m.requireRole.mockResolvedValueOnce({
      ok: false,
      response: new Response("{}", { status: 403 }),
    });
    const { status } = await chamar();
    expect(status).toBe(403);
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.investimento).not.toHaveBeenCalled();
  });

  it("pede manager", async () => {
    await chamar();
    expect(m.requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "metrics" }),
    );
  });
});

const INVALIDOS = [
  "de=2026-99-99",
  "de=2026-09-30&ate=2026-09-01",
  "de=2026-01-01&ate=2026-04-01",
  "dimensao=campo_contato",
  "dimensao=campo_contato&campo=obs",
  "dimensao=campo_card&campo=nao_existe",
  "dimensao=etiqueta",
  "pipeline_id=nao-uuid",
];

describe("validação", () => {
  it.each(INVALIDOS)("422 para %s", async (qs) => {
    const { status, corpo } = await chamar(qs);
    expect(status).toBe(422);
    expect(corpo.error.code).toBe("validation_failed");
  });

  it("toda mensagem de erro nova tem espanhol no dicionário", async () => {
    const mensagens = new Set<string>();
    for (const qs of INVALIDOS) mensagens.add((await chamar(qs)).corpo.error.message);
    mensagens.add((await chamar(`pipeline_id=${P_OUTRA}`)).corpo.error.message);
    erroEm = "crm_leads";
    mensagens.add((await chamar()).corpo.error.message);
    for (const msg of mensagens) expect(DICIONARIO[msg]?.es, msg).toBeTruthy();
  });

  it("funil de outra organização: 404", async () => {
    const { status, corpo } = await chamar(`pipeline_id=${P_OUTRA}`);
    expect(status).toBe(404);
    expect(corpo.error.code).toBe("not_found");
  });
});

describe("escopo de organização", () => {
  it("toda leitura filtra pela org do requireRole, mesmo com outra na query", async () => {
    const { status, corpo } = await chamar(
      `de=2026-09-01&ate=2026-09-30&organization_id=${OUTRA}&dimensao=campo_contato&campo=origem`,
    );
    expect(status).toBe(200);
    expect(consultas.length).toBeGreaterThan(0);
    for (const c of consultas) {
      expect(c.filtros, c.tabela).toContainEqual(["organization_id", "eq", ORG]);
    }
    expect(consultas.map((c) => c.tabela)).not.toContain("organizations");
    // Pelo EFEITO: o ganho de R$ 9.999 do vizinho não entrou.
    expect(corpo.data.numeros.receita).toEqual([{ moeda: "BRL", cents: "50000" }]);
    expect(corpo.data.numeros.agendados).toBe(2);
    expect(m.investimento).toHaveBeenCalledWith(expect.anything(), ORG, "2026-09-01", "2026-09-30");
  });
});

describe("escopo de funil", () => {
  it("o outro funil da MESMA org não entra em P, e aparece quando é o escolhido", async () => {
    const p = (await chamar()).corpo.data;
    for (const c of consultas.filter((x) => x.tabela === "crm_leads")) {
      expect(c.filtros).toContainEqual(["pipeline_id", "eq", P]);
    }
    // Pelo EFEITO: sem o filtro, L-P2 (R$ 7.777) e L-P2b entrariam, e A3/A4 também.
    expect(p.numeros).toMatchObject({
      leads: 2,
      ganhos: 1,
      receita: [{ moeda: "BRL", cents: "50000" }],
      ganhos_de_anuncio: 1,
      agendados: 2,
    });

    const p2 = (await chamar(`de=2026-09-01&ate=2026-09-30&pipeline_id=${P2}`)).corpo.data;
    expect(p2.funil).toEqual({ id: P2, nome: "Acompanhamento" });
    expect(p2.numeros).toMatchObject({
      leads: 2,
      interagiram: null,
      ganhos: 1,
      receita: [{ moeda: "BRL", cents: "777700" }],
      agendados: 2,
    });
  });

  it("funil sem etapa de interação: o recorte mostra null, nunca 0", async () => {
    const { corpo } = await chamar(
      `de=2026-09-01&ate=2026-09-30&pipeline_id=${P2}&dimensao=campo_contato&campo=origem`,
    );
    const linhas = corpo.data.dimensao.linhas as Array<{ interagiram: number | null }>;
    expect(linhas.length).toBeGreaterThan(0);
    for (const l of linhas) expect(l.interagiram).toBeNull();
  });
});

describe("contato anonimizado", () => {
  it("não conta como ganho de anúncio, nem em custo, nem em ROAS", async () => {
    banco.contacts!.push({
      id: "C4",
      organization_id: ORG,
      custom_fields: {},
      tags: [],
      is_anonymized: true,
      // Ainda aponta para o anúncio da campanha: só a anonimização o tira.
      source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "900001" } },
    });
    banco.crm_leads!.push({
      id: "L4",
      organization_id: ORG,
      pipeline_id: P,
      stage_id: "s-ganho",
      status: "won",
      contact_id: "C4",
      custom_fields: {},
      value_cents: 30000,
      currency: "BRL",
      created_at: ANTES,
      closed_at: NO_PERIODO,
    });
    const { corpo } = await chamar();
    expect(corpo.data.numeros).toMatchObject({
      ganhos: 2,
      ganhos_de_anuncio: 1,
      custo_por_venda_cents: 10000,
      roas: 5,
    });
    const linhas = (await chamar("de=2026-09-01&ate=2026-09-30&dimensao=campanha")).corpo.data
      .dimensao.linhas as Array<{ chave: string; ganhos: number }>;
    expect(linhas.find((l) => l.chave === "__sem_valor")?.ganhos).toBe(1);
  });
});

describe("falhas e corte", () => {
  it.each([
    "crm_leads",
    "crm_lead_activities",
    "crm_stages",
    "calendar_appointments",
    "crm_lead_links",
    "contacts",
  ])("erro lendo %s vira 500, nunca números zerados", async (tabela) => {
    erroEm = tabela;
    const { status, corpo } = await chamar(
      "de=2026-09-01&ate=2026-09-30&dimensao=campo_contato&campo=origem",
    );
    expect(status).toBe(500);
    expect(corpo.data).toBeUndefined();
  });

  it("coorte maior que 10 páginas: truncado", async () => {
    for (let i = 0; i < 10_001; i++) {
      banco.crm_leads!.push({
        id: `X${i}`,
        organization_id: ORG,
        pipeline_id: P,
        stage_id: "s-novo",
        status: "open",
        contact_id: null,
        custom_fields: {},
        created_at: NO_PERIODO,
      });
    }
    const { corpo } = await chamar();
    expect(corpo.data.truncado).toBe(true);
  });

  it("lote de movimentos com mais linhas do que cabe: truncado", async () => {
    for (let i = 0; i < 10_001; i++) {
      banco.crm_lead_activities!.push({
        id: `m${i}`,
        organization_id: ORG,
        lead_id: "L1",
        type: "stage_changed",
        payload: {},
        performed_at: NO_PERIODO,
      });
    }
    const { corpo } = await chamar();
    expect(corpo.data.truncado).toBe(true);
  });

  it("sem corte: truncado false", async () => {
    expect((await chamar()).corpo.data.truncado).toBe(false);
  });
});

describe("resposta", () => {
  it("números do período, sem PII", async () => {
    const { status, corpo } = await chamar();
    expect(status).toBe(200);
    const d = corpo.data;
    expect(d.periodo).toEqual({ de: "2026-09-01", ate: "2026-09-30", fuso: "America/Sao_Paulo" });
    expect(d.funil).toEqual({ id: P, nome: "Comercial" });
    expect(d.numeros).toMatchObject({
      leads: 2,
      interagiram: 1,
      taxa_interacao: 0.5,
      ganhos: 1,
      receita: [{ moeda: "BRL", cents: "50000" }],
      agendados: 2,
      realizados: 1,
      faltas: 1,
      taxa_comparecimento: 0.5,
    });
    expect(d.por_etapa.map((e: { alcancaram: number }) => e.alcancaram)).toEqual([2, 1, 0]);
    expect(d.investimento).toEqual({
      estado: "ok",
      conta: "Conta principal",
      moeda: "BRL",
      cents: 10000,
    });
    expect(d.opcoes.funis.map((f: { id: string }) => f.id)).toEqual([P, P2]);
    expect(d.opcoes.campos_contato).toEqual([
      { key: "modalidade", label: "Modalidade" },
      { key: "origem", label: "Origem" },
    ]);
    expect(d.dimensao).toBeNull();

    const chaves = new Set<string>();
    const varrer = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(varrer);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          chaves.add(k);
          varrer(x);
        }
    };
    varrer(corpo);
    for (const k of [
      "name",
      "phone_number",
      "email",
      "contact_id",
      "lead_id",
      "custom_fields",
      "tags",
    ])
      expect(chaves).not.toContain(k);
    const texto = JSON.stringify(corpo);
    for (const proibido of ["L1", "L2", "C1", "C2", "TEXTO-LIVRE-SECRETO"])
      expect(texto).not.toContain(`"${proibido}"`);
    expect(texto).not.toContain("TEXTO-LIVRE-SECRETO");
  });

  it("sem dimensão e com investimento ok: ganhos de anúncio, custo e ROAS calculados", async () => {
    const { corpo } = await chamar();
    expect(corpo.data.numeros).toMatchObject({
      ganhos_de_anuncio: 1,
      custo_por_venda_cents: 10000,
      roas: 5,
    });
  });

  it("sem investimento: ganhos de anúncio, custo e ROAS null", async () => {
    m.investimento.mockResolvedValueOnce({ estado: "nao_conectado" });
    const { corpo } = await chamar();
    expect(corpo.data.investimento).toEqual({ estado: "nao_conectado" });
    expect(corpo.data.numeros).toMatchObject({
      ganhos_de_anuncio: null,
      custo_por_venda_cents: null,
      roas: null,
    });
  });

  it("recorte por campo do card: opções do funil escolhido, fora da lista sem o texto", async () => {
    const { corpo } = await chamar(
      "de=2026-09-01&ate=2026-09-30&dimensao=campo_card&campo=modalidade",
    );
    const linhas = corpo.data.dimensao.linhas as Array<Record<string, unknown>>;
    expect(linhas.map((l) => [l.chave, l.leads, l.ganhos, l.agendados])).toEqual([
      ["online", 1, 0, 1],
      ["presencial", 0, 1, 0],
      ["__fora_da_lista", 1, 0, 1],
    ]);
  });

  it("recorte por campanha sem investimento ok: linhas vazias com o estado", async () => {
    m.investimento.mockResolvedValueOnce({ estado: "sem_conta" });
    const { corpo } = await chamar("de=2026-09-01&ate=2026-09-30&dimensao=campanha");
    expect(corpo.data.dimensao).toEqual({ tipo: "campanha", estado: "sem_conta", linhas: [] });
  });

  it("recorte por campanha: rótulo da campanha e gasto por linha", async () => {
    const { corpo } = await chamar("de=2026-09-01&ate=2026-09-30&dimensao=campanha");
    const linhas = corpo.data.dimensao.linhas as Array<Record<string, unknown>>;
    expect(linhas[0]).toMatchObject({
      chave: "120300001",
      rotulo: "Setembro",
      leads: 1,
      ganhos: 1,
      investimento_cents: 10000,
    });
  });
});
