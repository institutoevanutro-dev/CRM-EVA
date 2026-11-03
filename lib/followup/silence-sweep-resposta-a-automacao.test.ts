import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { runSilenceSweep, type ContatoEmSilencio, type SilenceSweepDb } from "./silence-sweep";

/**
 * Porte da #3729 do original: a varredura de silêncio não inscreve quem só
 * respondeu a uma mensagem automática nossa. Aqui o `db` é falso (mesmo desenho
 * de `silence-sweep-episodio.test.ts`) e o que se prende é a DECISÃO da
 * varredura: quem o adapter marcou não é inscrito, os outros seguem, adapter
 * sem o método não muda nada, e a guarda que falha não derruba a varredura.
 * A régua em si é de `resposta-a-automacao.test.ts`, contra a query real.
 */

const contato = (id: string, sentAt = "2026-10-28T12:11:00.000Z"): ContatoEmSilencio => ({
  contact_id: id,
  ultima_entrada_em: sentAt,
  ultima_entrada_gravada_em: sentAt,
});

function fakeDb(opts: {
  contatos?: ContatoEmSilencio[];
  soReagiram?: Set<string>;
  omitirMetodo?: boolean;
  falha?: Error;
  vivos?: Set<string>;
  comRetorno?: Set<string>;
  emCooldown?: Set<string>;
}) {
  const insert = vi.fn(async () => ({ inserted: true }));
  const perguntados: ContatoEmSilencio[][] = [];
  const db: SilenceSweepDb = {
    loadActiveSilencePointers: async () => [
      {
        id: "p-1",
        organization_id: "org-1",
        active_version_id: "v-1",
        threshold_minutes: 60,
        segments: [],
        active_since: "2026-01-01T00:00:00.000Z",
      },
    ],
    loadSilentContacts: async () => opts.contatos ?? [contato("so-reagiu"), contato("lead-frio")],
    loadUltimaInscricaoNoPonteiro: async () => new Map(),
    loadContatosComInscricaoViva: async () => opts.vivos ?? new Set(),
    loadContatosComRetornoVivo: async () => opts.comRetorno ?? new Set<string>(),
    loadContactIdsEmCooldown: async () => opts.emCooldown ?? new Set(),
    loadTriggerNodeId: async () => "t-1",
    insertEnrollment: insert,
  };
  if (!opts.omitirMetodo) {
    db.loadContatosQueSoResponderamAAutomacao = async (_org, contatos) => {
      perguntados.push(contatos);
      if (opts.falha) throw opts.falha;
      return new Set(contatos.map((c) => c.contact_id).filter((id) => opts.soReagiram?.has(id)));
    };
  }
  return { db, insert, perguntados };
}

const DEPS = {
  gateDb: { loadEnabledPublishedFollowupAgents: async () => [{ agentId: "a-1", pointerIds: ["p-1"] }] },
  clock: () => new Date("2026-10-28T15:00:00Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSilenceSweep — resposta a mensagem automática (#3729 do original)", () => {
  it("(a) quem só reagiu à automática NÃO é inscrito; o lead frio de verdade entra", async () => {
    const { db, insert } = fakeDb({ soReagiram: new Set(["so-reagiu"]) });

    const summary = await runSilenceSweep({ db, ...DEPS });

    expect(summary.skipped_resposta_a_automacao).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org-1",
        pointer_id: "p-1",
        version_id: "v-1",
        contact_id: "lead-frio",
        current_node_id: "t-1",
        agent_id: "a-1",
      }),
    );
  });

  it("(b) adapter sem o método: ninguém é barrado por este motivo (comportamento de antes)", async () => {
    const { db, insert } = fakeDb({ omitirMetodo: true, soReagiram: new Set(["so-reagiu"]) });

    const summary = await runSilenceSweep({ db, ...DEPS });

    expect(summary.skipped_resposta_a_automacao).toBe(0);
    expect(summary.enrolled).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("(c) ninguém só reagiu: o fluxo segue idêntico", async () => {
    const { db, insert, perguntados } = fakeDb({ soReagiram: new Set() });

    const summary = await runSilenceSweep({ db, ...DEPS });

    expect(perguntados.map((lote) => lote.map((c) => c.contact_id))).toEqual([["so-reagiu", "lead-frio"]]);
    expect(summary.skipped_resposta_a_automacao).toBe(0);
    expect(summary.enrolled).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("(d) só quem iria ao insert é perguntado: cooldown, vivo em outro fluxo e retorno ficam com o próprio contador", async () => {
    // O INVERSO do original, que perguntava antes do cooldown. Aqui a pergunta
    // lê mensagens a cada minuto, então vai só para quem chegaria ao insert — e
    // a auditoria do cron, que dispara por `enrolled`/`skipped_existing`, não muda.
    const { db, insert, perguntados } = fakeDb({
      contatos: [contato("em-cooldown"), contato("vivo"), contato("com-retorno"), contato("so-reagiu")],
      soReagiram: new Set(["em-cooldown", "vivo", "com-retorno", "so-reagiu"]),
      emCooldown: new Set(["em-cooldown"]),
      vivos: new Set(["vivo"]),
      comRetorno: new Set(["com-retorno"]),
    });

    const summary = await runSilenceSweep({ db, ...DEPS });

    expect(perguntados.map((lote) => lote.map((c) => c.contact_id))).toEqual([["so-reagiu"]]);
    expect(summary).toMatchObject({
      skipped_cooldown: 1,
      skipped_existing: 1,
      skipped_pending_return: 1,
      skipped_resposta_a_automacao: 1,
      enrolled: 0,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("(d) ninguém iria ao insert: a pergunta nem é feita", async () => {
    const { db, perguntados } = fakeDb({
      contatos: [contato("vivo"), contato("com-retorno")],
      vivos: new Set(["vivo"]),
      comRetorno: new Set(["com-retorno"]),
    });

    await runSilenceSweep({ db, ...DEPS });

    expect(perguntados).toEqual([]);
  });

  it("(e) a guarda lança: a varredura NÃO lança, inscreve os dois e loga o erro uma vez", async () => {
    const erro = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { db, insert } = fakeDb({
      soReagiram: new Set(["so-reagiu"]),
      falha: new Error("resposta_a_automacao_query_failed: boom"),
    });

    const summary = await runSilenceSweep({ db, ...DEPS });

    expect(summary.enrolled).toBe(2);
    expect(summary.skipped_resposta_a_automacao).toBe(0);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(erro).toHaveBeenCalledTimes(1);
    expect(erro).toHaveBeenCalledWith(
      expect.stringContaining("resposta_a_automacao"),
      expect.objectContaining({
        organization_id: "org-1",
        pointer_id: "p-1",
        error: "resposta_a_automacao_query_failed: boom",
      }),
    );
  });

  it("(f) recebe os MESMOS ContatoEmSilencio que a varredura mediu, com a mesma ultima_entrada_em", async () => {
    const soReagiu = contato("so-reagiu", "2026-10-28T12:11:00.123456+00:00");
    const leadFrio = contato("lead-frio", "2026-10-28T11:00:00+00:00");
    const { db, perguntados } = fakeDb({ contatos: [soReagiu, leadFrio] });

    await runSilenceSweep({ db, ...DEPS });

    expect(perguntados).toHaveLength(1);
    expect(perguntados[0]![0]).toBe(soReagiu);
    expect(perguntados[0]![1]).toBe(leadFrio);
    expect(perguntados[0]!.map((c) => c.ultima_entrada_em)).toEqual([
      "2026-10-28T12:11:00.123456+00:00",
      "2026-10-28T11:00:00+00:00",
    ]);
  });
});
