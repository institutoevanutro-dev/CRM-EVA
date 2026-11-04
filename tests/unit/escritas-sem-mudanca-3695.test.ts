/**
 * O VIGIA DAS SESSÕES NÃO MANDA AO BANCO UM UPDATE QUE NÃO MUDA NADA
 * (porte do DeskcommCRM, PR #3706, issue #3695).
 *
 * A cada tick do watchdog (knob `WATCHDOG_INTERVAL_MS`, 60 s por padrão), o
 * reconciliador lê o status de cada sessão no WAHA, lê o espelho em
 * `channel_sessions` e emitia `update channel_sessions set status = … where
 * waha_session_name = … and status is distinct from $2` mesmo com o espelho já
 * igual. O `is distinct from` fazia o banco devolver 0 linhas, mas a instrução
 * era emitida, parseada, planejada e varrida a cada tick, uma vez por sessão.
 *
 * Os casos são de CONTAGEM: com nada a mudar, o número de instruções de update
 * tem de ser ZERO; quando há mudança de verdade, continua sendo exatamente 1.
 * Contar só "houve escrita" deixaria passar a versão antiga do defeito.
 *
 * O arquivo do original também cobria um PATCH em `agent_inbox_items` (o aviso
 * do agendador de pausas na Central). Essa metade não existe neste fork e ficou
 * de fora; o nome do arquivo é o do original, para que mudanças futuras nele se
 * apliquem aqui.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { reconcileSessions, type WatchdogConfig } from "@/lib/agent-engine/edge/crm/session-reconciler";

const logFake = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cfg: WatchdogConfig = {
  wahaBaseUrl: "http://waha.local",
  wahaApiKey: "chave",
  intervalMs: 1,
  redriveMinAgeMs: 0,
  redriveBatchSize: 10,
  redriveSpacingMs: 0,
};

/**
 * Pool falso: aplica a regra do `where` na lista em memória e REGISTRA cada
 * instrução. O update de 0 linhas do defeito só é distinguível de um update que
 * mudou algo pelo que o banco devolve — então o fake decide pelos dados.
 */
function poolFalso(inicial: { id: string; status: string }[]) {
  const linhas = inicial.map((l) => ({ ...l }));
  const instrucoes: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    instrucoes.push(sql);
    if (/select cs\.id, cs\.status/i.test(sql)) return { rows: linhas.map((l) => ({ ...l })) };
    if (/update channel_sessions/i.test(sql)) {
      const [, novo] = params as [string, string];
      // `where waha_session_name = $1 and … status is distinct from $2`: sem
      // `is distinct from` no texto, o defeito volta e o caso 4 reprova.
      const temTrava = /status is distinct from \$2/i.test(sql);
      const alvo = temTrava ? linhas.filter((l) => l.status !== novo) : linhas;
      for (const l of alvo) l.status = novo;
      return { rows: alvo.map((l) => ({ id: l.id, status: l.status })) };
    }
    return { rows: [] };
  });
  return { query, instrucoes, linhas };
}

function wahaResponde(sessoes: Array<{ name: string; status: string }>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(sessoes), { status: 200 }));
}

const escritasDeSessao = (instrucoes: string[]) =>
  instrucoes.filter((sql) => /update channel_sessions/i.test(sql));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel_sessions: o espelho igual ao WAHA não gera instrução", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("espelho JÁ igual: nenhum UPDATE emitido (antes: 1 instrução por tick, 0 linhas)", async () => {
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "WORKING" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(corrigidas).toBe(0);
    expect(escritasDeSessao(banco.instrucoes)).toEqual([]);
    // O `select` continua: é ele que responde "há o que mudar?".
    expect(banco.instrucoes.some((sql) => /select cs\.id, cs\.status/i.test(sql))).toBe(true);
  });

  it("espelho divergente: exatamente UMA escrita, e o espelho acompanha o WAHA", async () => {
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "STARTING" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(corrigidas).toBe(1);
    expect(escritasDeSessao(banco.instrucoes)).toHaveLength(1);
    expect(banco.linhas[0]?.status).toBe("WORKING");
  });

  it("a trava de corrida fica no `where`: quem mudou a linha entre a leitura e a escrita não é sobrescrito", async () => {
    // O espelho diz STARTING, mas outra instância já gravou WORKING antes de o
    // UPDATE chegar. A trava preserva a corrida; neste caso o fake devolve 0
    // linhas e a rodada não conta como correção feita.
    wahaResponde([{ name: "s-1", status: "WORKING" }]);
    const banco = poolFalso([{ id: "cs-1", status: "STARTING" }]);
    const queryOriginal = banco.query.getMockImplementation()!;
    banco.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/update channel_sessions/i.test(sql)) banco.linhas[0]!.status = "WORKING";
      return queryOriginal(sql, params);
    });

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    const escrita = escritasDeSessao(banco.instrucoes)[0] ?? "";
    expect(escrita).toMatch(/status is distinct from \$2/i);
    expect(corrigidas).toBe(0);
  });

  it("sessão STOPPED é retomada e o espelho vira STARTING (uma escrita, como antes)", async () => {
    // É ESTE o caso que reprova se a guarda subir para antes da retomada: com
    // WAHA e espelho em STOPPED, ela pularia a sessão sem o POST /start (fetch
    // chamado 1 vez, não 2) e a sessão parada nunca seria religada.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ name: "s-1", status: "STOPPED" }]), { status: 200 }),
      )
      // O POST /start devolve 200 — a retomada foi aceita.
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const banco = poolFalso([{ id: "cs-1", status: "STOPPED" }]);

    const corrigidas = await reconcileSessions(banco as unknown as pg.Pool, cfg, logFake as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(escritasDeSessao(banco.instrucoes)).toHaveLength(1);
    expect(banco.linhas[0]?.status).toBe("STARTING");
    expect(corrigidas).toBe(1);
  });
});
