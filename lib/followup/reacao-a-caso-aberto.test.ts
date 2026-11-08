import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { contatosQueSoReagiramACasoAberto, soReacao } from "./reacao-a-caso-aberto";
import { runSilenceSweep, type ContatoEmSilencio, type SilenceSweepDb } from "./silence-sweep";

/**
 * Caso real (anonimizado): sexta 20:22 a IA abre um caso `awaiting_human` e diz
 * que a equipe responde na segunda; 20:23 o contato manda só "👍"; o fluxo de
 * silêncio de 30 min o inscrevia, e no dia seguinte a IA dizia "a equipe já viu
 * seu pedido". O 👍 não pode abrir silêncio novo.
 *
 * O fake é o PostgREST que GRAVA a cadeia (desenho de
 * `resposta-a-automacao.test.ts`) e responde uma entrada por consulta, na ordem:
 * organização, casos, entradas.
 */
type Chamada = { metodo: string; args: unknown[] };
type Resposta = unknown[] | Record<string, unknown> | { error: { message: string } };

function fakeAdmin(respostas: Resposta[]) {
  const consultas: Chamada[][] = [];
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
    const resposta = respostas[consultas.length] ?? [];
    consultas.push(chamadas);
    const resultado =
      !Array.isArray(resposta) && "error" in resposta ? { data: null, error: resposta.error } : { data: resposta, error: null };
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(resultado);
          return (...args: unknown[]) => {
            chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas };
}

const ORG = "org-1";
const ORG_SP = { timezone: "America/Sao_Paulo" };
const CASO_SEXTA_2022 = "2026-11-06T23:22:00.000Z";
const JOINHA_2023 = "2026-11-06T23:23:00.000Z";
const caso = (opened_at = CASO_SEXTA_2022, espera_desde: string | null = opened_at) => ({ opened_at, espera_desde });
const texto = (body: string) => ({ type: "text", body });
const candidato = { contactId: "c-1", conversationId: "conv-1", inboundAt: JOINHA_2023 };

describe("soReacao", () => {
  it.each([
    [texto("👍"), true],
    [texto("🙏🏻❤️"), true],
    [texto("!!"), true],
    [{ type: "sticker", body: null }, true],
    [{ type: "reaction", body: "👍" }, true],
    [texto("ok"), false],
    [texto("👍 e o preço?"), false],
    [{ type: "audio", body: null }, false],
    [{ type: "image", body: null }, false],
  ])("%j → %s", (linha, esperado) => {
    expect(soReacao(linha)).toBe(esperado);
  });
});

describe("contatosQueSoReagiramACasoAberto — a consulta", () => {
  it("caso real: 👍 um minuto depois do caso aberto → excluído", async () => {
    const { admin, consultas } = fakeAdmin([ORG_SP, [caso()], [texto("👍")]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set(["c-1"]));

    const [org, casos, entradas] = consultas;
    expect(org![0]!.args).toEqual(["organizations"]);
    expect(casos![0]!.args).toEqual(["agent_cases"]);
    expect(casos).toContainEqual({ metodo: "eq", args: ["organization_id", ORG] });
    expect(casos).toContainEqual({ metodo: "eq", args: ["conversation_id", "conv-1"] });
    expect(casos).toContainEqual({ metodo: "lte", args: ["opened_at", JOINHA_2023] });
    expect(casos).toContainEqual({ metodo: "or", args: [`status.eq.awaiting_human,closed_at.gt.${JOINHA_2023}`] });
    expect(entradas).toContainEqual({ metodo: "eq", args: ["organization_id", ORG] });
    expect(entradas).toContainEqual({ metodo: "eq", args: ["direction", "inbound"] });
    expect(entradas).toContainEqual({ metodo: "gte", args: ["sent_at", CASO_SEXTA_2022] });
  });

  it("figurinha também", async () => {
    const { admin } = fakeAdmin([ORG_SP, [caso()], [{ type: "sticker", body: null }]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set(["c-1"]));
  });

  it("sem caso esperando a equipe → segue elegível (e nem lê as entradas)", async () => {
    const { admin, consultas } = fakeAdmin([ORG_SP, [], [texto("👍")]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set());
    expect(consultas).toHaveLength(2);
  });

  it("escreveu algo com conteúdo desde o caso → segue elegível", async () => {
    const { admin } = fakeAdmin([ORG_SP, [caso()], [texto("👍"), texto("e o preço?")]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set());
  });

  it("caso com espera de mais de 2 dias úteis antes do 👍 → segue elegível", async () => {
    // Espera começou na terça 03/11 10h; o 👍 é sexta 06/11 20:23.
    const { admin } = fakeAdmin([ORG_SP, [caso("2026-11-03T13:00:00.000Z")], [texto("👍")]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set());
  });

  it("caso aberto há tempo, mas a espera pela equipe recomeçou agora (espera_desde) → excluído", async () => {
    const { admin } = fakeAdmin([ORG_SP, [caso("2026-10-01T13:00:00.000Z", CASO_SEXTA_2022)], [texto("👍")]]);
    expect(await contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).toEqual(new Set(["c-1"]));
  });

  it("erro de leitura LANÇA (quem chama decide a falha aberta)", async () => {
    const { admin } = fakeAdmin([ORG_SP, { error: { message: "boom" } }]);
    await expect(contatosQueSoReagiramACasoAberto(admin, ORG, [candidato])).rejects.toThrow("reacao_a_caso_aberto_query_failed");
  });
});

describe("runSilenceSweep — reação a caso aberto", () => {
  afterEach(() => vi.restoreAllMocks());

  const contato = (id: string): ContatoEmSilencio => ({ contact_id: id, ultima_entrada_em: JOINHA_2023, ultima_entrada_gravada_em: JOINHA_2023 });

  function fakeDb(opts: { reagiram?: Set<string>; falha?: Error; omitir?: boolean }) {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "p-1", organization_id: ORG, active_version_id: "v-1", threshold_minutes: 30, segments: [], active_since: "2026-01-01T00:00:00.000Z" },
      ],
      loadSilentContacts: async () => [contato("do-joinha"), contato("lead-frio")],
      loadUltimaInscricaoNoPonteiro: async () => new Map(),
      loadContatosComInscricaoViva: async () => new Set(),
      loadContatosComRetornoVivo: async () => new Set(),
      loadContactIdsEmCooldown: async () => new Set(),
      loadTriggerNodeId: async () => "t-1",
      insertEnrollment: insert,
    };
    if (!opts.omitir) {
      db.loadContatosQueSoReagiramACasoAberto = async (_org, contatos) => {
        if (opts.falha) throw opts.falha;
        return new Set(contatos.map((c) => c.contact_id).filter((id) => opts.reagiram?.has(id)));
      };
    }
    return { db, insert };
  }
  const DEPS = {
    gateDb: { loadEnabledPublishedFollowupAgents: async () => [{ agentId: "a-1", pointerIds: ["p-1"] }] },
    clock: () => new Date("2026-11-07T00:00:00Z"), // 37 min depois do 👍
  };

  it("caso real: o 👍 a um caso aberto NÃO inscreve; o lead frio entra", async () => {
    const { db, insert } = fakeDb({ reagiram: new Set(["do-joinha"]) });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(summary.skipped_reacao_a_caso_aberto).toBe(1);
    expect(summary.enrolled).toBe(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "lead-frio" }));
  });

  it("adapter sem o método: comportamento de antes", async () => {
    const { db, insert } = fakeDb({ omitir: true });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(summary.skipped_reacao_a_caso_aberto).toBe(0);
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("a guarda lança: a varredura segue, inscreve os dois e loga", async () => {
    const erro = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { db, insert } = fakeDb({ reagiram: new Set(["do-joinha"]), falha: new Error("reacao_a_caso_aberto_query_failed: boom") });
    const summary = await runSilenceSweep({ db, ...DEPS });
    expect(summary.enrolled).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(erro).toHaveBeenCalledWith(expect.stringContaining("reacao_a_caso_aberto"), expect.objectContaining({ pointer_id: "p-1" }));
  });
});
