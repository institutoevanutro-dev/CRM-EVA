import { describe, expect, it, vi } from "vitest";

import {
  atrasoMaximoDoSilencioMs,
  runSilenceSweep,
  type ContatoEmSilencio,
  type SilencePointer,
  type SilenceSweepDb,
} from "./silence-sweep";

/**
 * Incidente da clínica Rosa (17/11/2026): um fluxo de silêncio de 30 min
 * publicado às 17:56 e o acesso da IA ao canal aberto às 00:39 fizeram a
 * varredura inscrever, de uma vez, 80 conversas paradas desde 02/11. A regra:
 * só conta silêncio que começou DEPOIS de o fluxo valer para aquela conversa —
 * vigência do ponteiro, publicação da versão ativa e abertura do acesso da IA
 * no canal — e, como segunda trava, nada parado há mais que limiar + atraso
 * máximo.
 */

const AGORA = new Date("2026-11-17T00:44:00Z");
const contato = (id: string, sentAt: string, acesso?: string | null): ContatoEmSilencio => ({
  contact_id: id,
  ultima_entrada_em: sentAt,
  ultima_entrada_gravada_em: sentAt,
  ...(acesso !== undefined ? { acesso_da_ia_desde: acesso } : {}),
});

function fakeDb(pointer: Partial<SilencePointer>, contatos: ContatoEmSilencio[], pisos: Array<string | undefined> = []) {
  const insert = vi.fn(async () => ({ inserted: true }));
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [
      {
        id: "p-1",
        organization_id: "org-1",
        active_version_id: "v-1",
        threshold_minutes: 30,
        segments: [],
        active_since: "2026-10-01T00:00:00.000Z",
        ...pointer,
      },
    ],
    loadSilentContacts: async (_o, _c, _s, desde) => {
      pisos.push(desde);
      return contatos;
    },
    loadUltimaInscricaoNoPonteiro: async () => new Map(),
    loadContatosComInscricaoViva: async () => new Set(),
    loadContatosComRetornoVivo: async () => new Set(),
    loadContactIdsEmCooldown: async () => new Set(),
    loadTriggerNodeId: async () => "t-1",
    insertEnrollment: insert,
  };
  return { db, insert };
}

const DEPS = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [{ agentId: "a-1", pointerIds: ["p-1"] }] },
  clock: () => AGORA,
};

describe("silêncio sem retroativo", () => {
  it("versão publicada DEPOIS de o contato calar: não inscreve; quem calou depois da publicação entra", async () => {
    const { db, insert } = fakeDb({ version_since: "2026-11-16T17:56:00.000Z" }, [
      contato("antes", "2026-11-16T15:00:00.000Z"),
      contato("depois", "2026-11-16T18:30:00.000Z"),
    ]);
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "depois" }));
    expect(summary.skipped_before_activation).toBe(1);
  });

  it("acesso da IA ao canal aberto DEPOIS de o contato calar: não inscreve; silêncio posterior entra", async () => {
    const aberto = "2026-11-17T00:39:00.000Z";
    const { db, insert } = fakeDb({ version_since: "2026-11-16T17:56:00.000Z" }, [
      contato("antes", "2026-11-16T20:00:00.000Z", aberto),
      contato("depois", "2026-11-17T00:10:00.000Z", "2026-11-17T00:05:00.000Z"),
      contato("canal-sem-marca", "2026-11-16T20:00:00.000Z", null),
    ]);
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(insert.mock.calls.map((c) => (c as unknown as [{ contact_id: string }])[0].contact_id).sort()).toEqual([
      "canal-sem-marca",
      "depois",
    ]);
    expect(summary.skipped_before_activation).toBe(1);
  });

  it("teto de idade: silêncio mais velho que limiar + atraso máximo não entra, mesmo com vigência antiga", async () => {
    const atraso = 24 * 3_600_000;
    const { db, insert } = fakeDb({}, [
      contato("velho", new Date(AGORA.getTime() - 30 * 60_000 - atraso - 60_000).toISOString()),
      contato("recente", new Date(AGORA.getTime() - 30 * 60_000 - atraso + 60_000).toISOString()),
    ]);
    const summary = await runSilenceSweep({ db, ...DEPS, atrasoMaximoMs: atraso });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "recente" }));
    expect(summary.skipped_silencio_antigo).toBe(1);
  });

  it("o piso da leitura é o mais recente entre vigência, versão e teto", async () => {
    const pisos: Array<string | undefined> = [];
    const { db } = fakeDb({ version_since: "2026-11-16T17:56:00+00:00" }, [], pisos);
    await runSilenceSweep({ db, ...DEPS, atrasoMaximoMs: 24 * 3_600_000 });
    expect(pisos).toEqual(["2026-11-16T17:56:00.000Z"]);
    const pisos2: Array<string | undefined> = [];
    const { db: db2 } = fakeDb({}, [], pisos2);
    await runSilenceSweep({ db: db2, ...DEPS, atrasoMaximoMs: 3_600_000 });
    expect(pisos2).toEqual(["2026-11-16T23:14:00.000Z"]);
  });

  it("knob FOLLOWUP_SILENCIO_ATRASO_MAXIMO_HORAS: padrão 24 h, lixo cai no padrão", () => {
    expect(atrasoMaximoDoSilencioMs({})).toBe(24 * 3_600_000);
    expect(atrasoMaximoDoSilencioMs({ FOLLOWUP_SILENCIO_ATRASO_MAXIMO_HORAS: "abc" })).toBe(24 * 3_600_000);
    expect(atrasoMaximoDoSilencioMs({ FOLLOWUP_SILENCIO_ATRASO_MAXIMO_HORAS: "0" })).toBe(24 * 3_600_000);
    expect(atrasoMaximoDoSilencioMs({ FOLLOWUP_SILENCIO_ATRASO_MAXIMO_HORAS: "72" })).toBe(72 * 3_600_000);
  });
});
