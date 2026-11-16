import { describe, expect, it } from "vitest";

import {
  INTERVALO_DA_ESPERA_DA_INGESTAO_MS,
  respostaFicouObsoletaAposIngestao,
} from "@/lib/agent-engine/agent/turno-ja-respondido";

/**
 * A régua de resposta obsoleta espera a ingestão da mensagem nova terminar
 * antes de decidir — sem trocar o critério de prova (ver o cabeçalho de
 * `respostaFicouObsoletaAposIngestao`). Banco e relógio falsos: o banco
 * responde à consulta da ingestão e à da régua; `dormir` avança o tempo falso.
 */

const ALVO = { organizationId: "o", conversationId: "c", jobId: "j" };
const TETO = 120_000;

type Cenario = {
  /** Até quando (ms falsos) o `message.received` da mensagem nova fica em processamento. */
  ingestaoAte: number;
  /** Se, ao terminar, a ingestão pediu turno (dispatch) para a mensagem nova. */
  despachou: boolean;
};

function bancoFalso(c: Cenario) {
  let agora = 0;
  let consultasDaRegua = 0;
  const db = {
    query: async (sql: string) => {
      if (sql.includes("'message.received'")) {
        return { rows: [{ em_curso: agora < c.ingestaoAte }] };
      }
      consultasDaRegua += 1;
      // A régua de sempre: obsoleta só se há prova (o dispatch já nasceu).
      return { rows: [{ obsoleta: agora >= c.ingestaoAte && c.despachou }] };
    },
  };
  const dormir = async (ms: number) => {
    agora += ms;
  };
  return { db: db as never, dormir, reguaRodou: () => consultasDaRegua, agora: () => agora };
}

describe("respostaFicouObsoletaAposIngestao", () => {
  it("(a) ingestão em curso que despacha em 1 s: espera e descarta a resposta", async () => {
    const f = bancoFalso({ ingestaoAte: 1_000, despachou: true });
    expect(await respostaFicouObsoletaAposIngestao(f.db, ALVO, TETO, { ms: 5_000, dormir: f.dormir })).toBe(true);
    expect(f.agora()).toBe(1_000);
  });

  it("(b) ingestão que termina sem despacho: a resposta sai", async () => {
    const f = bancoFalso({ ingestaoAte: 1_000, despachou: false });
    expect(await respostaFicouObsoletaAposIngestao(f.db, ALVO, TETO, { ms: 5_000, dormir: f.dormir })).toBe(false);
    expect(f.reguaRodou()).toBe(1);
  });

  it("(c) a espera estoura antes de a ingestão terminar: a resposta sai, como antes", async () => {
    const f = bancoFalso({ ingestaoAte: 60_000, despachou: true });
    expect(await respostaFicouObsoletaAposIngestao(f.db, ALVO, TETO, { ms: 5_000, dormir: f.dormir })).toBe(false);
    expect(f.agora()).toBe(5_000);
  });

  it("espera 0 (knob desligado): não espera e decide na hora, como antes", async () => {
    const f = bancoFalso({ ingestaoAte: 1_000, despachou: true });
    expect(await respostaFicouObsoletaAposIngestao(f.db, ALVO, TETO, { ms: 0, dormir: f.dormir })).toBe(false);
    expect(f.agora()).toBe(0);
  });

  it("régua desligada (teto 0): nem espera nem consulta", async () => {
    const f = bancoFalso({ ingestaoAte: 1_000, despachou: true });
    expect(await respostaFicouObsoletaAposIngestao(f.db, ALVO, 0, { ms: 5_000, dormir: f.dormir })).toBe(false);
    expect(f.agora()).toBe(0);
    expect(f.reguaRodou()).toBe(0);
  });

  it("dorme no intervalo fixo, sem ler o relógio (o sleep dos testes não espera)", async () => {
    const pausas: number[] = [];
    const f = bancoFalso({ ingestaoAte: 600, despachou: true });
    await respostaFicouObsoletaAposIngestao(f.db, ALVO, TETO, {
      ms: 5_000,
      dormir: async (ms) => {
        pausas.push(ms);
        await f.dormir(ms);
      },
    });
    expect(pausas.every((p) => p === INTERVALO_DA_ESPERA_DA_INGESTAO_MS)).toBe(true);
    expect(pausas.length).toBe(Math.ceil(600 / INTERVALO_DA_ESPERA_DA_INGESTAO_MS));
  });
});
