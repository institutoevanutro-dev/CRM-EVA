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
  vivos?: Set<string>;
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
    loadContatosComInscricaoViva: async () => opts.vivos ?? new Set(),
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
