import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createLogger } from "../../obs/logger";

import { deveRetomarSessao, redriveQueued, reconcileSessions } from "./session-reconciler";

afterEach(() => vi.restoreAllMocks());

/**
 * ─── SESSÃO PRESA EM `STARTING` (porte do DeskcommCRM #4875) ─────────────────────────────────────
 *
 * O número ficou dias sem receber mensagem. O espelho dizia `STARTING`, o
 * reconciliador só religava `STOPPED` e nada avisava. Estes casos prendem o
 * vigia: `STARTING` acima do prazo é reiniciada (stop + start, sem logout),
 * `STARTING` recém-nascida é boot e não se toca, `WORKING` nunca é reiniciada,
 * e no limite o vigia PARA e deixa o aviso para o operador.
 *
 * O banco falso abaixo responde o SELECT pelo SQL (não pela ordem das chamadas):
 * assim os casos continuam válidos se um dia entrar mais uma consulta no tick.
 */
const minutos = (n: number) => n * 60_000;

function bancoDaSessao(linha: { status: string; last_status_change_at: Date; metadata: unknown }) {
  const escritas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/select cs\.id/i.test(sql)) return { rows: [{ id: "canal-1", ...linha }] };
    escritas.push({ sql, params: params ?? [] });
    return { rows: [] };
  });
  return { pool: { query } as unknown as pg.Pool, escritas };
}

function transporteQueResponde(status: string) {
  const chamadas: string[] = [];
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada) => {
    const url = String(entrada);
    chamadas.push(url);
    if (url.includes("/api/sessions?all=true")) {
      return new Response(JSON.stringify([{ name: "sessao-presa", status }]));
    }
    return new Response("{}", { status: 201 });
  });
  return { chamadas, transport };
}

describe("sessão presa em STARTING (#4870)", () => {
  const cfg = {
    wahaBaseUrl: "http://127.0.0.1:9999",
    wahaApiKey: "test-key",
    intervalMs: 1,
    redriveMinAgeMs: 0,
    redriveBatchSize: 1,
    redriveSpacingMs: 0,
  };

  it("⭐ STARTING acima do prazo é reiniciada — stop e start, nunca logout", async () => {
    const { chamadas, transport } = transporteQueResponde("STARTING");
    const { pool, escritas } = bancoDaSessao({
      status: "STARTING",
      last_status_change_at: new Date(Date.now() - minutos(10)),
      metadata: {},
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);

    expect(transport).toHaveBeenCalledTimes(3); // lista, stop, start
    expect(chamadas[1]).toContain("/stop");
    expect(chamadas[2]).toContain("/start");
    expect(chamadas.join(" ")).not.toContain("/logout");
    const contador = escritas.find((e) => e.sql.includes("jsonb_build_object"));
    expect(contador, "contador do vigia não foi gravado").toBeDefined();
    expect(JSON.parse(String(contador!.params[2]))).toMatchObject({ tentativas: 1, esgotado: false });
  });

  it("STARTING recém-nascida é boot: nada de restart", async () => {
    const { chamadas } = transporteQueResponde("STARTING");
    const { pool } = bancoDaSessao({
      status: "STARTING",
      last_status_change_at: new Date(Date.now() - 20_000),
      metadata: {},
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);
    expect(chamadas).toHaveLength(1); // só a listagem
  });

  it("⭐ sessão CONECTADA nunca sofre restart", async () => {
    const { chamadas } = transporteQueResponde("WORKING");
    const { pool } = bancoDaSessao({
      status: "WORKING",
      last_status_change_at: new Date(Date.now() - minutos(600)),
      metadata: {},
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);
    expect(chamadas).toHaveLength(1);
  });

  it("⭐ no limite o vigia para de tentar e marca o episódio como esgotado", async () => {
    const { chamadas } = transporteQueResponde("STARTING");
    const { pool, escritas } = bancoDaSessao({
      status: "STARTING",
      last_status_change_at: new Date(Date.now() - minutos(40)),
      metadata: {
        vigia_starting: {
          tentativas: 3,
          ultimo_restart_em: new Date(Date.now() - minutos(10)).toISOString(),
          esgotado: false,
        },
      },
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);

    expect(chamadas).toHaveLength(1); // nada de stop/start
    const contador = escritas.find((e) => e.sql.includes("jsonb_build_object"));
    expect(JSON.parse(String(contador!.params[2]))).toMatchObject({ tentativas: 3, esgotado: true });
  });

  it("quando a sessão sai de STARTING, o contador é limpo para o próximo episódio", async () => {
    transporteQueResponde("WORKING");
    const { pool, escritas } = bancoDaSessao({
      status: "WORKING",
      last_status_change_at: new Date(Date.now() - minutos(1)),
      metadata: { vigia_starting: { tentativas: 2, esgotado: true } },
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);
    expect(escritas.some((e) => e.sql.includes("- $2::text"))).toBe(true);
  });

  // O webhook de STARTING pode se perder (o update.sh reinicia app e WAHA juntos):
  // o espelho segue no status ANTERIOR, e o carimbo dele não é a idade do boot.
  it("⭐ espelho WORKING há 10 dias com o transporte entrando em STARTING é boot: nada de restart", async () => {
    const { chamadas } = transporteQueResponde("STARTING");
    const { pool } = bancoDaSessao({
      status: "WORKING",
      last_status_change_at: new Date(Date.now() - minutos(10 * 24 * 60)),
      metadata: {},
    });

    expect(await reconcileSessions(pool, cfg, createLogger())).toBe(0);
    expect(chamadas.some((u) => u.includes("/stop"))).toBe(false);
  });

  it("o reconciliador carimba last_status_change_at quando grava o status novo", async () => {
    transporteQueResponde("STARTING");
    const { pool, escritas } = bancoDaSessao({
      status: "WORKING",
      last_status_change_at: new Date(Date.now() - 1_000),
      metadata: {},
    });

    await reconcileSessions(pool, cfg, createLogger());
    const update = escritas.find((e) => /set status = \$2/.test(e.sql));
    expect(update, "update de status do espelho não foi feito").toBeDefined();
    expect(update!.sql).toContain("last_status_change_at = now()");
  });
});


/**
 * A regra que decide se o watchdog RELIGA a sessão. Religar FAILED é o que o
 * vigia de saúde recusa (pode ser banimento); SCAN_QR_CODE e STARTING já têm
 * dono. Só STOPPED: credencial no disco, sessão parada depois de restart.
 */
describe("deveRetomarSessao", () => {
  it("retoma só STOPPED", () => {
    expect(deveRetomarSessao("STOPPED")).toBe(true);
    expect(deveRetomarSessao("stopped")).toBe(true);
  });

  it.each(["WORKING", "STARTING", "SCAN_QR_CODE", "FAILED", ""])(
    "não religa %s — ou já está no ar, ou precisa de humano",
    (status) => {
      expect(deveRetomarSessao(status)).toBe(false);
    },
  );
});

describe("redrive pré-go-live", () => {
  it("não envia se a releitura da configuração falha", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockRejectedValueOnce(new Error("banco indisponível"));

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("m.organization_id = $2"), ["message-test", "org-test"]);
  });

  it("não reenvia mídia da biblioteca (a do turno nunca fica queued; a do follow-up é do retry dele)", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: "0" }] });
    await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger());
    expect(query.mock.calls[0]![0]).toContain("and m.media_library_item_id is null");
    expect(query.mock.calls[1]![0]).toContain("and m.media_library_item_id is null");
  });
});
