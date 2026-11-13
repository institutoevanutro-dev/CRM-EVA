import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type ContatoEmSilencio, type SilenceSweepDb } from "./silence-sweep";
import { triggerConfigSchema } from "./api-schemas";

/**
 * As regras de `runSilenceSweep` que decidem SE um contato calado entra:
 * vigência do ponteiro (sem passado) e, no próximo bloco, episódio de silêncio
 * (a sequência não recomeça sozinha). Spec:
 * docs/superpowers/specs/2026-10-06-followup-nao-recomeca-design.md, §4.1–4.2.
 */

const contato = (id: string, sentAt: string, createdAt = sentAt): ContatoEmSilencio => ({
  contact_id: id,
  ultima_entrada_em: sentAt,
  ultima_entrada_gravada_em: createdAt,
});

function fakeDb(opts: {
  activeSince?: string;
  contatos: ContatoEmSilencio[];
  ultimaInscricao?: Map<string, string>;
  vivos?: Set<string>;
  emCooldown?: Set<string>;
  reentradaMinimaHoras?: number;
  recentesQueEnviaram?: Set<string>;
  onReentrada?: (contactIds: string[], desdeIso: string) => void;
  onSilentContacts?: (desdeIso: string | undefined) => void;
  onCooldown?: (contactIds: string[], cutoffIso: string) => void;
  onUltimaInscricao?: (contactIds: string[], desdeIso: string) => void;
}) {
  const insert = vi.fn(async () => ({ inserted: true }));
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [
      {
        id: "p-1",
        organization_id: "org-1",
        active_version_id: "v-1",
        threshold_minutes: 60,
        segments: [],
        active_since: opts.activeSince ?? "2026-01-01T00:00:00.000Z",
        ...(opts.reentradaMinimaHoras !== undefined ? { reentrada_minima_horas: opts.reentradaMinimaHoras } : {}),
      },
    ],
    loadSilentContacts: async (_org, _cutoff, _segments, desdeIso) => {
      opts.onSilentContacts?.(desdeIso);
      return opts.contatos;
    },
    loadUltimaInscricaoNoPonteiro: async (_org, _pointer, contactIds, desdeIso) => {
      opts.onUltimaInscricao?.(contactIds, desdeIso);
      return opts.ultimaInscricao ?? new Map();
    },
    loadContatosComInscricaoViva: async () => opts.vivos ?? new Set(),
    loadContatosComRetornoVivo: async () => new Set<string>(),
    loadContactIdsEmCooldown: async (_org, _pointer, contactIds, cutoffIso) => {
      opts.onCooldown?.(contactIds, cutoffIso);
      return opts.emCooldown ?? new Set();
    },
    loadContatosComInscricaoRecenteQueEnviou: async (_org, _pointer, contactIds, desdeIso) => {
      opts.onReentrada?.(contactIds, desdeIso);
      return opts.recentesQueEnviaram ?? new Set();
    },
    loadTriggerNodeId: async () => "t-1",
    insertEnrollment: insert,
  };
  return { db, insert };
}

const DEPS = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [{ agentId: "a-1", pointerIds: ["p-1"] }] },
  clock: () => new Date("2026-10-06T15:00:00Z"),
};

describe("sem passado: silêncio anterior à vigência do ponteiro não conta", () => {
  it("(a) última entrada ANTES da vigência → sem inscrição, conta skipped_before_activation", async () => {
    const { db, insert } = fakeDb({
      activeSince: "2026-10-06T12:00:00.000Z",
      contatos: [contato("A", "2026-10-06T11:59:00.000Z")],
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).not.toHaveBeenCalled();
    expect(summary.skipped_before_activation).toBe(1);
  });

  it("(b) última entrada DEPOIS da vigência → inscreve; no instante exato, não (a regra é 'posterior')", async () => {
    const { db, insert } = fakeDb({
      activeSince: "2026-10-06T12:00:00.000Z",
      contatos: [contato("depois", "2026-10-06T12:01:00.000Z"), contato("exato", "2026-10-06T12:00:00.000Z")],
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "depois" }));
    expect(summary.skipped_before_activation).toBe(1);
  });

  it("passa a vigência do ponteiro à leitura, como piso no servidor", async () => {
    const pisos: Array<string | undefined> = [];
    const { db } = fakeDb({
      activeSince: "2026-10-06T12:00:00.000Z",
      contatos: [],
      onSilentContacts: (desde) => pisos.push(desde),
    });
    await runSilenceSweep({ db, ...DEPS });
    expect(pisos).toEqual(["2026-10-06T12:00:00.000Z"]);
  });

  it("compara instantes, não texto: o ISO do PostgREST (+00:00) contra o do JS (Z)", async () => {
    const { db, insert } = fakeDb({
      activeSince: "2026-10-06T12:00:00+00:00",
      contatos: [contato("A", "2026-10-06T12:00:00.500Z")],
    });
    await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("episódio de silêncio: a sequência não recomeça sozinha", () => {
  const ENTRADA = "2026-10-06T12:00:00.000Z";

  it("(c) já há inscrição deste ponteiro depois da última entrada → sem insert, skipped_same_episode (sem olhar status)", async () => {
    const { db, insert } = fakeDb({
      contatos: [contato("A", ENTRADA)],
      ultimaInscricao: new Map([["A", "2026-10-06T12:30:00.000Z"]]),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).not.toHaveBeenCalled();
    expect(summary.skipped_same_episode).toBe(1);
    expect(summary.skipped_existing).toBe(0);
  });

  it("(d) a inscrição é anterior à última entrada (o contato respondeu depois) → episódio novo, inscreve", async () => {
    const { db, insert } = fakeDb({
      contatos: [contato("A", ENTRADA)],
      ultimaInscricao: new Map([["A", "2026-10-06T11:00:00.000Z"]]),
    });
    await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("(e) started_at igual à entrada conta como do mesmo episódio (>=)", async () => {
    const { db, insert } = fakeDb({
      contatos: [contato("A", ENTRADA)],
      ultimaInscricao: new Map([["A", "2026-10-06T12:00:00+00:00"]]),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).not.toHaveBeenCalled();
    expect(summary.skipped_same_episode).toBe(1);
  });

  it("(f) o episódio compara com o created_at (relógio do banco), e o desde passado é o MENOR deles", async () => {
    const chamadas: Array<{ contactIds: string[]; desde: string }> = [];
    const { db, insert } = fakeDb({
      contatos: [
        // enviada às 11:00, gravada às 12:10 — chegou depois da inscrição das 12:05
        contato("A", "2026-10-06T11:00:00.000Z", "2026-10-06T12:10:00.000Z"),
        contato("B", "2026-10-06T11:30:00.000Z", "2026-10-06T11:30:00.000Z"),
      ],
      ultimaInscricao: new Map([["A", "2026-10-06T12:05:00.000Z"]]),
      onUltimaInscricao: (contactIds, desde) => chamadas.push({ contactIds, desde }),
    });
    await runSilenceSweep({ db, ...DEPS });
    expect(chamadas).toEqual([{ contactIds: ["A", "B"], desde: "2026-10-06T11:30:00.000Z" }]);
    expect(insert).toHaveBeenCalledTimes(2); // A abriu episódio novo pelo created_at
  });

  it("(g) do mesmo episódio E vivo conta skipped_same_episode, não skipped_existing (não audita)", async () => {
    const { db, insert } = fakeDb({
      contatos: [contato("A", ENTRADA)],
      ultimaInscricao: new Map([["A", "2026-10-06T12:30:00.000Z"]]),
      vivos: new Set(["A"]),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).not.toHaveBeenCalled();
    expect(summary.skipped_same_episode).toBe(1);
    expect(summary.skipped_existing).toBe(0);
  });
});

describe("cooldown pela conclusão: a sequência não encosta na anterior", () => {
  // Porte do 2240b215e do original. Com cancel_on_reply desligado (o padrão),
  // a resposta durante a inscrição só a ACORDA; o fluxo segue até o End. A
  // resposta é posterior ao started_at — episódio novo pela regra acima —, e
  // sem o cooldown a sequência recomeçava no tick seguinte à conclusão.
  it("(h) episódio novo, mas a inscrição anterior TERMINOU há menos que o limiar → sem insert, skipped_cooldown", async () => {
    const chamadas: Array<{ contactIds: string[]; cutoff: string }> = [];
    const { db, insert } = fakeDb({
      contatos: [contato("A", "2026-10-06T12:00:00.000Z"), contato("B", "2026-10-06T12:00:00.000Z")],
      ultimaInscricao: new Map([["A", "2026-10-06T11:00:00.000Z"]]), // começou ANTES da resposta
      emCooldown: new Set(["A"]),
      onCooldown: (contactIds, cutoff) => chamadas.push({ contactIds, cutoff }),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "B" }));
    expect(summary.skipped_cooldown).toBe(1);
    expect(summary.skipped_same_episode).toBe(0);
    // o corte é o mesmo do silêncio: agora (15:00) − 60 min
    expect(chamadas).toEqual([{ contactIds: ["A", "B"], cutoff: "2026-10-06T14:00:00.000Z" }]);
  });

  it("(i) quem já é do mesmo episódio nem chega à consulta de cooldown", async () => {
    const chamadas: string[][] = [];
    const { db } = fakeDb({
      contatos: [contato("A", "2026-10-06T12:00:00.000Z")],
      ultimaInscricao: new Map([["A", "2026-10-06T12:30:00.000Z"]]),
      onCooldown: (contactIds) => chamadas.push(contactIds),
    });
    await runSilenceSweep({ db, ...DEPS });
    expect(chamadas).toEqual([]);
  });
});

describe("teto de recomeço (params.reentrada_minima_horas)", () => {
  // Medido em produção: cada resposta abria episódio novo e um contato recebeu
  // 8 mensagens em 4 dias. O teto barra a reinscrição enquanto uma inscrição
  // deste ponteiro que MANDOU algo começou há menos de N horas. Quem decide
  // "mandou" e "qualquer status" é a consulta (silence-sweep-consultas.test.ts).
  const A = () => contato("A", "2026-10-06T12:00:00.000Z");
  const B = () => contato("B", "2026-10-06T12:00:00.000Z");

  it("sem o parâmetro: nem pergunta, e inscreve como antes", async () => {
    const perguntas: string[][] = [];
    const { db, insert } = fakeDb({
      contatos: [A(), B()],
      recentesQueEnviaram: new Set(["A"]),
      onReentrada: (ids) => perguntas.push(ids),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(perguntas).toEqual([]);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(summary.skipped_reentrada).toBe(0);
    expect(summary.enrolled).toBe(2);
  });

  it("com o parâmetro: quem teve inscrição recente que enviou fica fora, conta skipped_reentrada", async () => {
    const chamadas: Array<{ ids: string[]; desde: string }> = [];
    const { db, insert } = fakeDb({
      contatos: [A(), B()],
      reentradaMinimaHoras: 48,
      recentesQueEnviaram: new Set(["A"]),
      onReentrada: (ids, desde) => chamadas.push({ ids, desde }),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "B" }));
    expect(summary.skipped_reentrada).toBe(1);
    expect(summary.enrolled).toBe(1);
    // agora (06/10 15:00) − 48 h
    expect(chamadas).toEqual([{ ids: ["A", "B"], desde: "2026-10-04T15:00:00.000Z" }]);
  });

  it("só pergunta por quem passou do episódio e do cooldown", async () => {
    const chamadas: string[][] = [];
    const { db } = fakeDb({
      contatos: [A(), B(), contato("C", "2026-10-06T12:00:00.000Z")],
      ultimaInscricao: new Map([["A", "2026-10-06T12:30:00.000Z"]]), // mesmo episódio
      emCooldown: new Set(["B"]),
      reentradaMinimaHoras: 24,
      onReentrada: (ids) => chamadas.push(ids),
    });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(chamadas).toEqual([["C"]]);
    expect(summary).toMatchObject({ skipped_same_episode: 1, skipped_cooldown: 1, skipped_reentrada: 0, enrolled: 1 });
  });
});

describe("schema do gatilho: reentrada_minima_horas", () => {
  const base = { kind: "silence", params: { threshold_minutes: 60 } } as const;
  const comHoras = (h: unknown) => ({ ...base, params: { ...base.params, reentrada_minima_horas: h } });

  it("opcional: sem ele o gatilho de hoje continua válido", () => {
    expect(triggerConfigSchema.safeParse(base).success).toBe(true);
  });

  it("aceita inteiro positivo; recusa zero, negativo, fração, texto e mais de 30 dias", () => {
    expect(triggerConfigSchema.safeParse(comHoras(48)).success).toBe(true);
    expect(triggerConfigSchema.safeParse(comHoras(720)).success).toBe(true);
    for (const ruim of [0, -1, 1.5, "48", 721]) {
      expect(triggerConfigSchema.safeParse(comHoras(ruim)).success, String(ruim)).toBe(false);
    }
  });
});
