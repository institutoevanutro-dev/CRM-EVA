import { describe, expect, it, vi } from "vitest";

import { runSilenceSweep, type ContatoEmSilencio, type SilenceSweepDb } from "./silence-sweep";

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
      },
    ],
    loadSilentContacts: async () => opts.contatos,
    loadUltimaInscricaoNoPonteiro: async (_org, _pointer, contactIds, desdeIso) => {
      opts.onUltimaInscricao?.(contactIds, desdeIso);
      return opts.ultimaInscricao ?? new Map();
    },
    loadContatosComInscricaoViva: async () => opts.vivos ?? new Set(),
    loadContactIdsEmCooldown: async (_org, _pointer, contactIds, cutoffIso) => {
      opts.onCooldown?.(contactIds, cutoffIso);
      return opts.emCooldown ?? new Set();
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
