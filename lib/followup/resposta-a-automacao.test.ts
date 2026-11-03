import { describe, expect, it } from "vitest";

import {
  contatosQueSoResponderamAAutomacao,
  JANELA_DA_RESPOSTA_A_AUTOMACAO_MS,
  type CandidatoDoSilencio,
} from "./resposta-a-automacao";

/**
 * `contatosQueSoResponderamAAutomacao` contra a query REAL (porte da #3729 do
 * original). O defeito: uma regra de automação manda parabéns às 09h07, o
 * cliente responde um coração às 09h11, e o fluxo de silêncio passa a mandar a
 * sequência de venda para quem só agradeceu.
 *
 * O fake é o PostgREST que GRAVA a cadeia (mesmo desenho de
 * `silence-sweep-inscricao-viva-query.test.ts`): filtrar é trabalho do
 * Postgres. Ele responde uma entrada por consulta, na ordem das chamadas —
 * saída do candidato 1, entradas do candidato 1, e assim por diante —, e uma
 * entrada pode ser um erro. O que se prova aqui é (a) a pergunta e (b) a decisão
 * sobre as linhas que voltam. Os casos de "não é automática" existem para que o
 * conserto não vire um silenciador geral do fluxo.
 */
type Chamada = { metodo: string; args: unknown[] };
type Resposta = Array<Record<string, unknown>> | { error: { message: string } };

function fakeAdmin(respostas: Resposta[]) {
  const consultas: Chamada[][] = [];
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
    const resposta = respostas[consultas.length] ?? [];
    consultas.push(chamadas);
    const resultado = Array.isArray(resposta) ? { data: resposta, error: null } : { data: null, error: resposta.error };
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return (resolve: (value: unknown) => unknown) => resolve(resultado);
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
const H = 3_600_000;
/** 09h07 e 09h11 em Brasília: a automática e a resposta do relato. */
const AUTOMATICA_AT = "2026-10-28T12:07:00.000Z";
const INBOUND_AT = "2026-10-28T12:11:00.000Z";

function candidato(contactId: string, conversationId: string, inboundAt: string): CandidatoDoSilencio {
  return { contactId, conversationId, inboundAt };
}

/** A saída como o select achatado a devolve: `->>` dá texto ou null. Padrão = regra "Enviar WhatsApp". */
function saida(over: Record<string, unknown> = {}) {
  return {
    sent_via: "ai",
    sent_at: AUTOMATICA_AT,
    ai_actor_id: null,
    ai_generated: null,
    texto_escrito_pela_ia: null,
    aviso_fora_do_horario: null,
    texto_fixo_do_fluxo: null,
    ...over,
  };
}

const texto = (body: string) => ({ type: "text", body });
const REACAO = { type: "reaction", body: null };

function argsDe(chamadas: Chamada[], metodo: string, coluna?: string): unknown[] | undefined {
  return chamadas.find((c) => c.metodo === metodo && (coluna === undefined || c.args[0] === coluna))?.args;
}

async function decide(
  respostas: Resposta[],
  candidatos: CandidatoDoSilencio[] = [candidato("contato-1", "conv-1", INBOUND_AT)],
  memo?: Map<string, boolean>,
) {
  const { admin, consultas } = fakeAdmin(respostas);
  const fora = await contatosQueSoResponderamAAutomacao(admin, ORG, candidatos, memo);
  return { fora, consultas };
}

describe("contatosQueSoResponderamAAutomacao — a pergunta e a decisão", () => {
  it("o caso do relato: regra de automação às 09h07, coração às 09h11 → fora do fluxo", async () => {
    const { fora, consultas } = await decide([[saida()], [texto("❤️")]]);

    expect(fora).toEqual(new Set(["contato-1"]));
    expect(consultas).toHaveLength(2);

    // Fase 1: a ÚLTIMA saída que chegou ao cliente antes da resposta, até 48 h antes.
    const daSaida = consultas[0]!;
    expect(daSaida[0]).toEqual({ metodo: "from", args: ["messages"] });
    expect(daSaida).toContainEqual({ metodo: "eq", args: ["organization_id", ORG] });
    expect(daSaida).toContainEqual({ metodo: "eq", args: ["conversation_id", "conv-1"] });
    expect(daSaida).toContainEqual({ metodo: "eq", args: ["direction", "outbound"] });
    expect(daSaida).toContainEqual({ metodo: "in", args: ["status", ["sent", "delivered", "read"]] });
    expect(argsDe(daSaida, "gte", "sent_at")).toEqual(["sent_at", new Date(Date.parse(INBOUND_AT) - 48 * H).toISOString()]);
    expect(argsDe(daSaida, "lte", "sent_at")).toEqual(["sent_at", INBOUND_AT]);
    expect(daSaida).toContainEqual({ metodo: "order", args: ["sent_at", { ascending: false }] });
    expect(daSaida).toContainEqual({ metodo: "limit", args: [1] });
    const select = String(argsDe(daSaida, "select")?.[0]);
    for (const alias of [
      "ai_actor_id:metadata->>ai_actor_id",
      "ai_generated:metadata->>ai_generated",
      "texto_escrito_pela_ia:metadata->>texto_escrito_pela_ia",
      "aviso_fora_do_horario:metadata->>aviso_fora_do_horario",
      "texto_fixo_do_fluxo:metadata->>texto_fixo_do_fluxo",
    ]) {
      expect(select).toContain(alias);
    }

    // Fase 2: as entradas dele, de 48 h antes da automática até a resposta.
    const dasEntradas = consultas[1]!;
    expect(dasEntradas[0]).toEqual({ metodo: "from", args: ["messages"] });
    expect(dasEntradas).toContainEqual({ metodo: "eq", args: ["organization_id", ORG] });
    expect(dasEntradas).toContainEqual({ metodo: "eq", args: ["conversation_id", "conv-1"] });
    expect(dasEntradas).toContainEqual({ metodo: "eq", args: ["direction", "inbound"] });
    expect(argsDe(dasEntradas, "gte", "sent_at")).toEqual([
      "sent_at",
      new Date(Date.parse(AUTOMATICA_AT) - 48 * H).toISOString(),
    ]);
    expect(argsDe(dasEntradas, "lte", "sent_at")).toEqual(["sent_at", INBOUND_AT]);
    expect(dasEntradas).toContainEqual({ metodo: "limit", args: [20] });
  });

  it("respondeu ao agente de IA → elegível, sem a segunda leitura", async () => {
    const { fora, consultas } = await decide([[saida({ ai_actor_id: "agente-1" })]]);
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(1);
  });

  it("uma pessoa escreveu pelo Inbox depois da automática: a última saída é dela → elegível", async () => {
    const { fora, consultas } = await decide([[saida({ sent_via: "user", sent_at: "2026-10-28T12:09:00.000Z" })]]);
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(1);
  });

  it("uma pessoa escreveu pelo celular (external_device) depois da automática → elegível", async () => {
    const { fora } = await decide([[saida({ sent_via: "external_device", sent_at: "2026-10-28T12:09:00.000Z" })]]);
    expect(fora).toEqual(new Set());
  });

  it("automática com mais de 48 h fica fora da leitura: nada volta → elegível, numa consulta só", async () => {
    const { fora, consultas } = await decide([[]]);
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(1);
    const desde = argsDe(consultas[0]!, "gte", "sent_at")![1] as string;
    expect(Date.parse(INBOUND_AT) - Date.parse(desde)).toBe(JANELA_DA_RESPOSTA_A_AUTOMACAO_MS);
  });

  it("campanha → fora: neste fork ela sai como webhook_source, gravada como 'ai' sem marca de autoria", async () => {
    const { fora } = await decide(
      [[saida({ sent_at: "2026-10-28T11:00:00.000Z" })], [texto("👍")]],
      [candidato("contato-campanha", "conv-campanha", "2026-10-28T11:04:00.000Z")],
    );
    expect(fora).toEqual(new Set(["contato-campanha"]));
  });

  it("dois números do mesmo contato: só o inbound mais novo decide (automática na conv-b vencedora → fora)", async () => {
    const { fora, consultas } = await decide(
      [[saida()], [texto("❤️")]],
      [candidato("contato-1", "conv-a", "2026-10-28T08:00:00.000Z"), candidato("contato-1", "conv-b", INBOUND_AT)],
    );
    expect(fora).toEqual(new Set(["contato-1"]));
    expect(consultas).toHaveLength(2);
    expect(consultas[0]).toContainEqual({ metodo: "eq", args: ["conversation_id", "conv-b"] });
  });

  it("o inverso: automática na conv-a mais velha e agente na conv-b vencedora → elegível", async () => {
    const { fora, consultas } = await decide(
      [[saida({ ai_actor_id: "agente-1" })], [saida()], [texto("❤️")]],
      [candidato("contato-1", "conv-b", INBOUND_AT), candidato("contato-1", "conv-a", "2026-10-28T08:00:00.000Z")],
    );
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toContainEqual({ metodo: "eq", args: ["conversation_id", "conv-b"] });
  });

  it("lista vazia não bate no banco", async () => {
    const { fora, consultas } = await decide([[saida()]], []);
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(0);
  });
});

describe("contatosQueSoResponderamAAutomacao — só corta quando NADA do que ele mandou tem conteúdo", () => {
  it("linha de reação, sem corpo → fora (ramo de canal que grava reação; o toque do WhatsApp nem vira linha aqui)", async () => {
    const { fora } = await decide([[saida()], [REACAO]]);
    expect(fora).toEqual(new Set(["contato-1"]));
  });

  it.each(["❤️", "👍🏽"])("texto só de emoji (%s), sem letra nem dígito → fora", async (corpo) => {
    const { fora } = await decide([[saida()], [texto(corpo)]]);
    expect(fora).toEqual(new Set(["contato-1"]));
  });

  it("'quero, quanto custa?' respondido à automática → elegível (recebe a retomada)", async () => {
    const { fora } = await decide([[saida()], [texto("quero, quanto custa?")]]);
    expect(fora).toEqual(new Set());
  });

  it("reação e depois texto com conteúdo no mesmo período → elegível", async () => {
    const { fora } = await decide([[saida()], [texto("quanto fica o pacote?"), REACAO]]);
    expect(fora).toEqual(new Set());
  });

  it("figurinha conta como conteúdo → elegível", async () => {
    const { fora } = await decide([[saida()], [{ type: "sticker", body: null }]]);
    expect(fora).toEqual(new Set());
  });

  it("recuo do fork: mensagem com conteúdo 10 h ANTES da automática está no período → elegível (lead quente)", async () => {
    const { fora, consultas } = await decide([[saida()], [texto("❤️"), texto("quero marcar uma avaliação")]]);
    expect(fora).toEqual(new Set());
    const desde = Date.parse(argsDe(consultas[1]!, "gte", "sent_at")![1] as string);
    expect(desde).toBeLessThanOrEqual(Date.parse(AUTOMATICA_AT) - 10 * H);
  });

  it("20 entradas no período = conversa ativa → elegível sem olhar uma a uma", async () => {
    const { fora } = await decide([[saida()], Array.from({ length: 20 }, () => texto("❤️"))]);
    expect(fora).toEqual(new Set());
  });
});

describe("contatosQueSoResponderamAAutomacao — a autoria pelas marcas que o fork grava", () => {
  it("texto fixo do fluxo pelo worker (ai_actor_id + marca) e '❤️' → fora: a marca vence", async () => {
    const { fora } = await decide([[saida({ ai_actor_id: "agente-1", texto_fixo_do_fluxo: "true" })], [texto("❤️")]]);
    expect(fora).toEqual(new Set(["contato-1"]));
  });

  it("texto fixo do fluxo pelo atalho inline (só a marca) e '❤️' → fora", async () => {
    const { fora } = await decide([[saida({ texto_fixo_do_fluxo: "true" })], [texto("❤️")]]);
    expect(fora).toEqual(new Set(["contato-1"]));
  });

  it("aviso de fora do horário e '👍' → elegível: ele responde à pergunta do próprio paciente", async () => {
    const { fora, consultas } = await decide([[saida({ aviso_fora_do_horario: "true" })], [texto("👍")]]);
    expect(fora).toEqual(new Set());
    expect(consultas).toHaveLength(1);
  });

  it("aviso de passagem para a equipe (ai_actor_id) → elegível", async () => {
    const { fora } = await decide([[saida({ ai_actor_id: "handoff-orchestrator" })], [texto("👍")]]);
    expect(fora).toEqual(new Set());
  });

  it("regra 'Mensagem escrita pela IA' (texto_escrito_pela_ia, sem ai_actor_id) → elegível: é fala da IA", async () => {
    const { fora } = await decide([[saida({ texto_escrito_pela_ia: "true" })], [texto("❤️")]]);
    expect(fora).toEqual(new Set());
  });

  it("worker legado (ai_generated) → elegível", async () => {
    const { fora } = await decide([[saida({ ai_generated: "true" })], [texto("❤️")]]);
    expect(fora).toEqual(new Set());
  });

  it("sent_via 'automation', se um dia for gravado → fora", async () => {
    const { fora } = await decide([[saida({ sent_via: "automation" })], [texto("❤️")]]);
    expect(fora).toEqual(new Set(["contato-1"]));
  });
});

describe("contatosQueSoResponderamAAutomacao — memória da decisão e erro de leitura", () => {
  it("com a mesma memória, a segunda chamada não lê nada e devolve o mesmo conjunto", async () => {
    const memo = new Map<string, boolean>();
    const primeira = await decide([[saida()], [texto("❤️")]], undefined, memo);
    const segunda = await decide([[saida({ ai_actor_id: "agente-1" })]], undefined, memo);

    expect(primeira.fora).toEqual(new Set(["contato-1"]));
    expect(segunda.fora).toEqual(new Set(["contato-1"]));
    expect(segunda.consultas).toHaveLength(0);
    expect([...memo.entries()]).toEqual([[`${ORG}:conv-1:${INBOUND_AT}`, true]]);
  });

  it("inbound com menos de 10 min não fica na memória: a segunda chamada lê de novo", async () => {
    const memo = new Map<string, boolean>();
    const recente = [candidato("contato-1", "conv-1", new Date(Date.now() - 60_000).toISOString())];
    const automatica = saida({ sent_at: new Date(Date.now() - 5 * 60_000).toISOString() });

    await decide([[automatica], [texto("❤️")]], recente, memo);
    const segunda = await decide([[automatica], [texto("❤️")]], recente, memo);

    expect(memo.size).toBe(0);
    expect(segunda.consultas).toHaveLength(2);
    expect(segunda.fora).toEqual(new Set(["contato-1"]));
  });

  it("memória no teto de 5_000 chaves é zerada antes de guardar", async () => {
    const memo = new Map<string, boolean>(Array.from({ length: 5_000 }, (_, i) => [`velha-${i}`, false] as const));
    await decide([[saida()], [texto("❤️")]], undefined, memo);
    expect([...memo.entries()]).toEqual([[`${ORG}:conv-1:${INBOUND_AT}`, true]]);
  });

  it("erro de leitura, em qualquer das duas fases, lança resposta_a_automacao_query_failed e nada fica na memória", async () => {
    const memo = new Map<string, boolean>();
    await expect(decide([{ error: { message: "boom" } }], undefined, memo)).rejects.toThrow(
      "resposta_a_automacao_query_failed: boom",
    );
    await expect(decide([[saida()], { error: { message: "boom 2" } }], undefined, memo)).rejects.toThrow(
      "resposta_a_automacao_query_failed: boom 2",
    );
    expect(memo.size).toBe(0);
  });
});
