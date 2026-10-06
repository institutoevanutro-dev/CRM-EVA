/**
 * As contas PURAS do Painel do funil (passos 1–8 do plano
 * `docs/superpowers/plans/2026-10-06-painel-do-funil.md`).
 *
 * Nada aqui toca banco nem rede: a rota lê, estas funções contam. É o que
 * permite provar cada régua do desenho com uma fixture pequena e legível.
 */
import { describe, expect, it } from "vitest";

import {
  FORA_DA_LISTA,
  SEM_VALOR,
  agregarAgenda,
  agregarCoorte,
  agregarGanhos,
  agregarPorDimensao,
  cardDoCompromisso,
  custoERoas,
  etapaDeInteracao,
  janelaDoPeriodo,
  periodoPadrao,
  posicaoAlcancada,
  valoresDaDimensao,
  type Dimensao,
  type Etapa,
} from "@/lib/metrics/painel-do-funil";

const etapa = (id: string, position: number, extra: Partial<Etapa> = {}): Etapa => ({
  id,
  name: id,
  position,
  is_won: false,
  is_lost: false,
  is_archived: false,
  agent_stage_hint: null,
  ...extra,
});

const ETAPAS: Etapa[] = [
  etapa("novo", 10),
  etapa("interagiu", 20, { agent_stage_hint: "contacted" }),
  etapa("negociacao", 30),
  etapa("ganho", 40, { is_won: true }),
  etapa("perdido", 50, { is_lost: true }),
  etapa("velha", 25, { is_archived: true }),
];
const POR_ID = new Map(ETAPAS.map((e) => [e.id, e]));
const mov = (payload: unknown) => ({ payload });

// ─── Passo 1 ────────────────────────────────────────────────────────────────
describe("janela do período no fuso da organização", () => {
  it("vira instantes UTC semiabertos no fuso", () => {
    expect(
      janelaDoPeriodo({ de: "2026-09-01", ate: "2026-09-30", fuso: "America/Sao_Paulo" }),
    ).toEqual({
      inicio: "2026-09-01T03:00:00.000Z",
      fimExclusivo: "2026-10-01T03:00:00.000Z",
      dias: 30,
    });
  });

  it("o padrão são 30 dias terminando ONTEM no fuso, como a tela Meta Ads", () => {
    // 02:00Z de 06/10 = 23h de 05/10 em Brasília: "hoje" é 05/10.
    expect(periodoPadrao(new Date("2026-10-06T02:00:00Z"), "America/Sao_Paulo")).toEqual({
      de: "2026-09-05",
      ate: "2026-10-04",
    });
  });

  it("recusa período invertido e mais longo que 90 dias", () => {
    expect(() => janelaDoPeriodo({ de: "2026-09-02", ate: "2026-09-01", fuso: "UTC" })).toThrow(
      new RangeError("periodo_invertido"),
    );
    expect(() => janelaDoPeriodo({ de: "2026-01-01", ate: "2026-04-01", fuso: "UTC" })).toThrow(
      new RangeError("periodo_longo"),
    );
    expect(janelaDoPeriodo({ de: "2026-01-01", ate: "2026-03-31", fuso: "UTC" }).dias).toBe(90);
  });
});

// ─── Passo 2 ────────────────────────────────────────────────────────────────
describe("chegou à etapa — as duas gramáticas de payload", () => {
  it("card que nunca andou: a etapa atual", () => {
    expect(posicaoAlcancada({ stage_id: "novo" }, [], POR_ID)).toBe(10);
  });

  it("lê from/to (humano) e de/para (máquina); voltar não apaga o avanço", () => {
    const movimentos = [
      mov({ from_stage_id: "novo", to_stage_id: "negociacao" }),
      mov({ de: "negociacao", para: "interagiu" }),
    ];
    expect(posicaoAlcancada({ stage_id: "interagiu" }, movimentos, POR_ID)).toBe(30);
  });

  it("etapa de perda não conta como avanço", () => {
    expect(
      posicaoAlcancada(
        { stage_id: "perdido" },
        [mov({ de: "interagiu", para: "perdido" })],
        POR_ID,
      ),
    ).toBe(20);
  });

  it("etapa de outro funil e payload torto são ignorados sem lançar", () => {
    const movimentos = [
      mov({ from_stage_id: "de-outro-funil", to_stage_id: "novo" }),
      mov({ qualquer: 1 }),
      mov("texto"),
      mov(null),
      mov([1, 2]),
      mov({ de: 42, para: "interagiu" }),
    ];
    expect(posicaoAlcancada({ stage_id: "novo" }, movimentos, POR_ID)).toBe(20);
  });

  it("etapa ARQUIVADA não conta pela posição", () => {
    expect(
      posicaoAlcancada(
        { stage_id: "interagiu" },
        [mov({ de: "novo", para: "velha" }), mov({ de: "velha", para: "interagiu" })],
        POR_ID,
      ),
    ).toBe(20);
    // Passou pela arquivada (25) e voltou: continua em 10, nunca 25.
    expect(
      posicaoAlcancada(
        { stage_id: "novo" },
        [mov({ de: "novo", para: "velha" }), mov({ de: "velha", para: "novo" })],
        POR_ID,
      ),
    ).toBe(10);
  });
});

// ─── Passo 3 ────────────────────────────────────────────────────────────────
describe("coorte: leads, interagiram e funil por etapa", () => {
  const cards = [
    { id: "c1", stage_id: "novo", status: "open" },
    { id: "c2", stage_id: "interagiu", status: "open" },
    { id: "c3", stage_id: "ganho", status: "won" },
    { id: "c4", stage_id: "perdido", status: "lost" },
  ];
  const movimentosPorCard = new Map([
    ["c2", [mov({ from_stage_id: "novo", to_stage_id: "interagiu" })]],
    ["c4", [mov({ de: "novo", para: "perdido" })]],
  ]);

  it("conta quem chegou a cada etapa, sem perdida e sem arquivada", () => {
    expect(agregarCoorte({ etapas: ETAPAS, cards, movimentosPorCard })).toEqual({
      leads: 4,
      interagiram: 2,
      taxa_interacao: 0.5,
      por_etapa: [
        { stage_id: "novo", nome: "novo", alcancaram: 4 },
        { stage_id: "interagiu", nome: "interagiu", alcancaram: 2 },
        { stage_id: "negociacao", nome: "negociacao", alcancaram: 1 },
        { stage_id: "ganho", nome: "ganho", alcancaram: 1 },
      ],
      perdidos: 1,
      aviso: null,
    });
  });

  it("funil sem etapa ligada a 'Primeiro contato': null com aviso, nunca zero", () => {
    const semHint = ETAPAS.map((e) => ({ ...e, agent_stage_hint: null }));
    const r = agregarCoorte({ etapas: semHint, cards, movimentosPorCard });
    expect(r.interagiram).toBeNull();
    expect(r.taxa_interacao).toBeNull();
    expect(r.aviso).toBe("sem_etapa_de_interacao");
  });

  it("0 cards: taxa null, não 0 inventado", () => {
    const r = agregarCoorte({ etapas: ETAPAS, cards: [], movimentosPorCard: new Map() });
    expect(r.leads).toBe(0);
    expect(r.interagiram).toBe(0);
    expect(r.taxa_interacao).toBeNull();
  });

  it("etapa ARQUIVADA com o passo é ignorada; vale a ativa", () => {
    // Duas ATIVAS com o mesmo passo são impossíveis (uniq_crm_stages_pipeline_hint);
    // a arquivada que guardou o passo é o caso real.
    const comArquivada = [
      ...ETAPAS.filter((e) => e.id !== "velha"),
      etapa("velha", 5, { is_archived: true, agent_stage_hint: "contacted" }),
    ];
    expect(etapaDeInteracao(comArquivada)?.id).toBe("interagiu");
    const soArquivada = comArquivada.map((e) =>
      e.id === "interagiu" ? { ...e, agent_stage_hint: null } : e,
    );
    expect(etapaDeInteracao(soArquivada)).toBeNull();
    const r = agregarCoorte({ etapas: soArquivada, cards, movimentosPorCard });
    expect(r.interagiram).toBeNull();
    expect(r.aviso).toBe("sem_etapa_de_interacao");
  });
});

// ─── Passo 4 ────────────────────────────────────────────────────────────────
describe("ganhos e receita por moeda", () => {
  it("soma por moeda em bigint serializado; sem valor e sem moeda ficam à parte", () => {
    expect(
      agregarGanhos([
        { value_cents: 49000, currency: "BRL" },
        { value_cents: "65000", currency: "BRL" },
        { value_cents: null, currency: "BRL" },
        { value_cents: 1000, currency: "USD" },
        { value_cents: 500, currency: null },
      ]),
    ).toEqual({
      ganhos: 5,
      receita: [
        { moeda: "BRL", cents: "114000" },
        { moeda: "USD", cents: "1000" },
      ],
      sem_valor: 1,
      sem_moeda: 1,
    });
  });
});

// ─── Passo 5 ────────────────────────────────────────────────────────────────
describe("agenda", () => {
  const agora = Date.parse("2026-09-20T12:00:00Z");
  const passado = "2026-09-10T12:00:00Z";
  const futuro = "2026-09-25T12:00:00Z";

  it("agendados sem cancelados; sem baixa é o que já terminou sem desfecho", () => {
    const c = (status: string, ends_at = passado) => ({ status, ends_at });
    expect(
      agregarAgenda(
        [
          c("completed"),
          c("completed"),
          c("completed"),
          c("no_show"),
          c("confirmed"),
          c("pending", futuro),
          c("cancelled"),
          c("cancelled"),
        ],
        agora,
      ),
    ).toEqual({
      agendados: 6,
      realizados: 3,
      faltas: 1,
      sem_baixa: 1,
      cancelados: 2,
      taxa_comparecimento: 0.75,
    });
  });

  it("só cancelados: taxa null", () => {
    expect(
      agregarAgenda([{ status: "cancelled", ends_at: passado }], agora).taxa_comparecimento,
    ).toBeNull();
  });
});

// ─── Passo 6 ────────────────────────────────────────────────────────────────
describe("custo por venda e ROAS", () => {
  const ok = { estado: "ok" as const, moeda: "BRL", cents: 100000 };
  it("custo = investimento ÷ ganhos de anúncio; ROAS na moeda da conta", () => {
    expect(
      custoERoas({
        investimento: ok,
        ganhosDeAnuncio: 4,
        receitaDeAnuncio: [{ moeda: "BRL", cents: "300000" }],
      }),
    ).toEqual({
      custo_por_venda_cents: 25000,
      roas: 3,
    });
  });
  it("receita em outra moeda: ROAS null, custo continua", () => {
    expect(
      custoERoas({
        investimento: ok,
        ganhosDeAnuncio: 4,
        receitaDeAnuncio: [{ moeda: "USD", cents: "300000" }],
      }),
    ).toEqual({
      custo_por_venda_cents: 25000,
      roas: null,
    });
  });
  it("0 ganhos de anúncio: custo null", () => {
    expect(
      custoERoas({ investimento: ok, ganhosDeAnuncio: 0, receitaDeAnuncio: [] })
        .custo_por_venda_cents,
    ).toBeNull();
  });
  it("investimento 0: ROAS null", () => {
    expect(
      custoERoas({
        investimento: { ...ok, cents: 0 },
        ganhosDeAnuncio: 1,
        receitaDeAnuncio: [{ moeda: "BRL", cents: "100" }],
      }).roas,
    ).toBeNull();
  });
  it("sem investimento ok: os dois null", () => {
    expect(
      custoERoas({
        investimento: { estado: "nao_conectado" },
        ganhosDeAnuncio: 3,
        receitaDeAnuncio: [{ moeda: "BRL", cents: "1" }],
      }),
    ).toEqual({ custo_por_venda_cents: null, roas: null });
  });
});

// ─── Passo 7 ────────────────────────────────────────────────────────────────
const ORIGEM: Dimensao = {
  tipo: "campo_contato",
  campo: "origem",
  opcoes: [
    { value: "instagram", label: "Instagram" },
    { value: "indicacao", label: "Indicação" },
  ],
};
const contato = (extra: Record<string, unknown> = {}) => ({
  custom_fields: {},
  tags: [] as string[],
  is_anonymized: false,
  ...extra,
});

describe("valor da dimensão por card", () => {
  it("campo do contato: opção, ausente, fora da lista, contato nulo", () => {
    expect(
      valoresDaDimensao(ORIGEM, { contato: contato({ custom_fields: { origem: "indicacao" } }) }),
    ).toEqual(["indicacao"]);
    expect(valoresDaDimensao(ORIGEM, { contato: contato() })).toEqual([SEM_VALOR]);
    expect(
      valoresDaDimensao(ORIGEM, { contato: contato({ custom_fields: { origem: "tiktok" } }) }),
    ).toEqual([FORA_DA_LISTA]);
    expect(valoresDaDimensao(ORIGEM, { contato: null })).toEqual([SEM_VALOR]);
  });

  it("campo do card lê o card", () => {
    const modalidade: Dimensao = { ...ORIGEM, tipo: "campo_card", campo: "modalidade" };
    expect(
      valoresDaDimensao(modalidade, { card: { custom_fields: { modalidade: "instagram" } } }),
    ).toEqual(["instagram"]);
    expect(valoresDaDimensao(modalidade, { card: { custom_fields: { modalidade: 3 } } })).toEqual([
      FORA_DA_LISTA,
    ]);
  });

  it("etiqueta: normaliza prefixo e CADA etiqueta, sem repetir", () => {
    const d: Dimensao = { tipo: "etiqueta", prefixo: "Criativo-" };
    expect(
      valoresDaDimensao(d, { contato: contato({ tags: ["criativo-a", "criativo-b", "vip"] }) }),
    ).toEqual(["criativo-a", "criativo-b"]);
    expect(
      valoresDaDimensao(d, { contato: contato({ tags: ["Criativo-A", "criativo-a"] }) }),
    ).toEqual(["criativo-a"]);
    expect(valoresDaDimensao(d, { contato: contato({ tags: ["vip"] }) })).toEqual([SEM_VALOR]);
  });

  it("campanha", () => {
    const d: Dimensao = { tipo: "campanha" };
    expect(valoresDaDimensao(d, { contato: contato(), campanha: "123" })).toEqual(["123"]);
    expect(valoresDaDimensao(d, { contato: contato(), campanha: null })).toEqual([SEM_VALOR]);
  });

  it("contato anonimizado não tem valor em dimensão nenhuma do contato", () => {
    const anon = contato({
      is_anonymized: true,
      custom_fields: { origem: "indicacao" },
      tags: ["criativo-a"],
    });
    expect(valoresDaDimensao(ORIGEM, { contato: anon })).toEqual([SEM_VALOR]);
    expect(
      valoresDaDimensao({ tipo: "etiqueta", prefixo: "criativo-" }, { contato: anon }),
    ).toEqual([SEM_VALOR]);
    expect(valoresDaDimensao({ tipo: "campanha" }, { contato: anon, campanha: "123" })).toEqual([
      SEM_VALOR,
    ]);
  });
});

// ─── Passo 8 ────────────────────────────────────────────────────────────────
describe("compromisso → card deste funil", () => {
  const cards = new Map([
    ["card-a", { id: "card-a", contact_id: "pessoa-1", created_at: "2026-09-01T00:00:00Z" }],
    ["card-b", { id: "card-b", contact_id: "pessoa-1", created_at: "2026-09-05T00:00:00Z" }],
  ]);
  const porContato = new Map([["pessoa-1", [...cards.values()]]]);

  it("dois vínculos a cards deste funil: vale o mais recente", () => {
    const vinculos = [
      { lead_id: "card-b", created_at: "2026-09-02T00:00:00Z" },
      { lead_id: "card-a", created_at: "2026-09-08T00:00:00Z" },
    ];
    expect(cardDoCompromisso({ contact_id: "pessoa-1" }, vinculos, cards, porContato)?.id).toBe(
      "card-a",
    );
  });

  it("vínculo só a card de outro funil: não é deste funil", () => {
    expect(
      cardDoCompromisso(
        { contact_id: "pessoa-1" },
        [{ lead_id: "outro", created_at: "2026-09-02T00:00:00Z" }],
        cards,
        porContato,
      ),
    ).toBeNull();
  });

  it("sem vínculo: card mais recente do contato neste funil", () => {
    expect(cardDoCompromisso({ contact_id: "pessoa-1" }, [], cards, porContato)?.id).toBe("card-b");
    expect(cardDoCompromisso({ contact_id: "pessoa-2" }, [], cards, porContato)).toBeNull();
    expect(cardDoCompromisso({ contact_id: null }, [], cards, porContato)).toBeNull();
  });
});

describe("tabela por dimensão", () => {
  const modalidade: Dimensao = {
    tipo: "campo_card",
    campo: "modalidade",
    opcoes: [
      { value: "online", label: "Online" },
      { value: "presencial", label: "Presencial" },
      { value: "hibrido", label: "Híbrido" },
    ],
  };
  const r = agregarPorDimensao({
    dimensao: modalidade,
    temEtapaDeInteracao: true,
    coorte: [
      { chaves: ["online"], interagiu: true },
      { chaves: ["online"], interagiu: false },
      { chaves: [FORA_DA_LISTA], interagiu: true },
    ],
    ganhos: [
      { chaves: ["online"], value_cents: 49000, currency: "BRL" },
      // Ganho de card criado ANTES do período: entra em ganhos, não em leads.
      { chaves: ["presencial"], value_cents: 65000, currency: "BRL" },
    ],
    agenda: [
      { chaves: ["online"], status: "completed" },
      { chaves: ["presencial"], status: "no_show" },
    ],
  });

  it("todas as opções aparecem (zeradas), e os baldes especiais só com contagem", () => {
    expect(r.map((l) => l.chave)).toEqual(["online", "presencial", "hibrido", FORA_DA_LISTA]);
    expect(r.find((l) => l.chave === "hibrido")).toMatchObject({
      rotulo: "Híbrido",
      leads: 0,
      ganhos: 0,
      agendados: 0,
    });
  });

  it("cada linha conta leads, interagiram, ganhos, receita, agendados, realizados", () => {
    expect(r[0]).toEqual({
      chave: "online",
      rotulo: "Online",
      leads: 2,
      interagiram: 1,
      ganhos: 1,
      receita: [{ moeda: "BRL", cents: "49000" }],
      agendados: 1,
      realizados: 1,
    });
    expect(r[1]).toMatchObject({
      chave: "presencial",
      leads: 0,
      ganhos: 1,
      agendados: 1,
      realizados: 0,
    });
    // O balde fora da lista não carrega o texto digitado.
    expect(r[3]).toMatchObject({ chave: FORA_DA_LISTA, rotulo: null, leads: 1 });
  });

  it("interagiram é null quando o funil não tem a etapa de interação", () => {
    const sem = agregarPorDimensao({
      dimensao: modalidade,
      temEtapaDeInteracao: false,
      coorte: [{ chaves: ["online"], interagiu: null }],
      ganhos: [],
      agenda: [],
    });
    expect(sem[0]!.interagiram).toBeNull();
  });

  // O "não dá para medir" vem da ETAPA, não do conteúdo da coorte: sem card
  // criado no período, `coorte.some(...)` não tem o que ler e virava 0 falso,
  // enquanto o cartão do topo mostrava "—" no mesmo carregamento.
  it("coorte vazia sem etapa de interação: null, nunca 0; com a etapa, 0 é zero de verdade", () => {
    const entrada = {
      dimensao: modalidade,
      coorte: [],
      ganhos: [{ chaves: ["online"], value_cents: 100, currency: "BRL" }],
      agenda: [{ chaves: ["online"], status: "completed" }],
    };
    const sem = agregarPorDimensao({ ...entrada, temEtapaDeInteracao: false });
    expect(sem.map((l) => l.interagiram)).toEqual([null, null, null]);
    const com = agregarPorDimensao({ ...entrada, temEtapaDeInteracao: true });
    expect(com.map((l) => l.interagiram)).toEqual([0, 0, 0]);
  });

  it("campanha: rótulo do insight, id quando não houve gasto, investimento por linha", () => {
    const linhas = agregarPorDimensao({
      dimensao: { tipo: "campanha" },
      temEtapaDeInteracao: true,
      coorte: [
        { chaves: ["111"], interagiu: true },
        { chaves: ["222"], interagiu: false },
        { chaves: [SEM_VALOR], interagiu: false },
      ],
      ganhos: [],
      agenda: [],
      campanhas: new Map([["111", { nome: "Campanha de setembro", cents: 5000 }]]),
    });
    expect(linhas.map((l) => [l.chave, l.rotulo, l.investimento_cents])).toEqual([
      ["111", "Campanha de setembro", 5000],
      ["222", "222", 0],
      [SEM_VALOR, null, null],
    ]);
  });

  it("privacidade: nenhum id de card/contato nem valor fora da lista no resultado", () => {
    const texto = JSON.stringify(r);
    for (const proibido of ["card-a", "card-b", "pessoa-1", "tiktok"])
      expect(texto).not.toContain(proibido);
  });
});
