/**
 * PEDIDO NOVO NUM CASO JÁ ABERTO: NINGUÉM É AVISADO, ENTÃO A IA NÃO PODE DIZER
 * QUE AVISOU (#3097 do original, porte do PR #3173 adaptado ao fork).
 *
 * No original a guarda de caso aberto RECUSA o pedido novo e a recusa virou
 * instrução. No fork o pedido do mesmo assunto não é recusado: entra no caso que
 * já aguarda a equipe como nota (`agent_noted`, `merged`), e a nota não avisa
 * ninguém. O resultado da ferramenta levava junto a frase de disponibilidade, que
 * com alguém online diz ao modelo "pode dizer ao cliente que alguém continua o
 * atendimento em seguida". Este arquivo prende as duas pontas: a instrução
 * honesta e a ligação dela no caminho `merged` do turno.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO,
  instrucaoDePedidoNoCasoAberto,
  openCase,
  type CaseIds,
} from "./human-cases";

const ids: CaseIds = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
};
const CASO_ANTIGO = "33333333-3333-4333-8333-333333333333";
const PEDIDO_NOVO = {
  title: "Remarcar o retorno",
  summary: "A cliente pediu outra coisa depois do caso já aberto.",
  blocker: "Precisa de uma pessoa para remarcar.",
  kind: "agendamento",
};

function poolDoEngine(linha: Record<string, unknown>) {
  const consultas: string[] = [];
  const pool = {
    query: (sql: string) => {
      consultas.push(sql);
      return Promise.resolve({ rows: [linha], rowCount: 1 });
    },
  } as never;
  return { pool, consultas };
}

describe("pedido novo num caso do mesmo assunto já aberto (#3097)", () => {
  it("openCase anota no caso antigo e devolve `merged` (o caminho que não avisa ninguém)", async () => {
    const { pool, consultas } = poolDoEngine({
      opened_id: null,
      existing_id: CASO_ANTIGO,
      existing_status: "awaiting_human",
      noted: true,
    });

    const res = await openCase(pool, ids, PEDIDO_NOVO);

    expect(res).toEqual({ ok: true, caseId: CASO_ANTIGO, merged: true });
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toContain("'agent_noted'");
  });

  it("a instrução proíbe dizer que a equipe foi acionada e entrega a frase ao cliente", () => {
    const texto = instrucaoDePedidoNoCasoAberto();

    expect(texto).toContain("NÃO foi avisada");
    expect(texto).toMatch(/NÃO diga ao cliente que a equipe foi acionada/u);
    expect(texto).toContain("não prometa prazo");
    expect(texto).toContain(FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO);
    // A frase de disponibilidade que autorizava a promessa não entra aqui.
    expect(texto).not.toMatch(/continua o atendimento em seguida/u);
  });

  it("a frase ao cliente não promete aviso, prazo nem resposta", () => {
    expect(FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO).not.toMatch(
      /equipe|acionad|avisad|encaminh|vai responder|em breve/iu,
    );
  });

  it("CONTROLE: o primeiro pedido continua abrindo o caso, sem `merged`", async () => {
    const { pool } = poolDoEngine({
      opened_id: "44444444-4444-4444-8444-444444444444",
      existing_id: null,
      existing_status: null,
      noted: false,
    });

    const res = await openCase(pool, ids, PEDIDO_NOVO);

    expect(res).toEqual({ ok: true, caseId: "44444444-4444-4444-8444-444444444444" });
  });
});

describe("fiação: o caminho `merged` da ferramenta usa a instrução", () => {
  const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

  it("o ramo `merged` devolve a instrução antes de ler a disponibilidade", () => {
    const ramo = FONTE.indexOf("if (res.merged) {");
    expect(ramo, "o turno não trata mais o ramo `merged`").toBeGreaterThan(-1);
    const corpo = FONTE.slice(ramo, FONTE.indexOf("}", ramo));
    expect(corpo).toContain("instrucaoDePedidoNoCasoAberto()");
    expect(corpo).not.toContain("frase");
  });
});
