import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { tentarRespostaPronta } from "@/lib/agent-engine/agent/resposta-pronta";

/**
 * "Nunca respondeu" tem de ser distinguível de "nunca rodou". Em produção a
 * resposta pronta ficou semanas com zero usos e nenhum log, porque a recusa por
 * limite era silenciosa. Este teste prova que toda recusa deixa o motivo (e a
 * similaridade, quando houve comparação) — e nunca o texto do cliente.
 */
function poolFalso(similaridade: number | null): pg.Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("respostas_prontas_config")) return { rows: [{ limite: 0.82, tem_perguntas: true }] };
    if (sql.includes("<=>"))
      return { rows: similaridade === null ? [] : [{ id: "r1", resposta: "Rua X", similaridade }] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const ids = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  leadId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000003",
  channelSessionId: "00000000-0000-4000-8000-000000000004",
  jobId: "00000000-0000-4000-8000-000000000005",
};

async function rodar(pool: pg.Pool, pendentes: string[]) {
  const log = logFalso();
  const desfecho = await tentarRespostaPronta(pool, ids, {
    channel: { send: vi.fn() } as never,
    optedOutThisTurn: false,
    now: new Date("2026-10-27T12:00:00Z"),
    log: log as never,
    pendentes,
    embed: (async () => ({ embedding: [0.1, 0.2] })) as never,
  });
  return { desfecho, log };
}

describe("resposta pronta registra por que não respondeu", () => {
  it("abaixo do limite: loga motivo e similaridade, sem o texto do cliente", async () => {
    const { desfecho, log } = await rodar(poolFalso(0.7134), ["Qual o endereço?"]);
    expect(desfecho).toMatchObject({ respondeu: false, motivo: "abaixo_do_limite" });
    expect(log.info).toHaveBeenCalledWith("resposta pronta não usada — o turno segue para a IA", {
      motivo: "abaixo_do_limite",
      similaridade: 0.713,
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("endereço");
  });

  it("barrada antes da comparação: loga só o motivo", async () => {
    const { log } = await rodar(poolFalso(0.9), ["Qual o endereço? E o horário?"]);
    expect(log.info).toHaveBeenCalledWith("resposta pronta não usada — o turno segue para a IA", {
      motivo: "mais_de_uma_pergunta",
    });
  });
});
