/**
 * A FALHA DA PODA É DITA, MAS NÃO 288 VEZES POR DIA (revisão do PR 125).
 *
 * `webhook-log-retention` roda a cada 5 minutos (`docker/scheduler/entrypoint.sh`).
 * Quando o conserto do #1721/#1769 fez a falha SUBIR, cada rodada que falha
 * passou a gravar uma linha `retention.sweep_run falhou` e a mandar um evento
 * ao Sentry — sem teto. Uma causa persistente (grant ausente depois de um
 * update, timeout) rende 288 linhas idênticas por dia e por tabela, cada uma
 * pela cadeia de hash da auditoria, sem nenhuma linha apagada. É a classe que
 * o CLAUDE.md mede em "95% do audit log era batida de cron".
 *
 * No `data-retention`, que é diário, a mesma exceção custa uma linha por dia.
 * A régua aqui é a mesma: UMA linha por poda por dia. O log de erro e o 500
 * continuam em TODA rodada — é a trilha e o alerta que têm teto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { esquecerFalhasAvisadas } from "@/lib/retencao/falha-avisada";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "segredo",
    INTERNAL_SECRET: "",
    WEBHOOK_LOG_BODY_RETENTION_DAYS: 7,
    WEBHOOK_LOG_ROW_RETENTION_DAYS: 90,
    LEAD_CAPTURE_RETENTION_DAYS: "",
  },
}));

const auditou = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...args: unknown[]) => auditou(...args) }));
const capturou = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => capturou(...args),
}));
const logou = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => logou(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Quais tabelas recusam o DELETE nesta rodada. */
let recusam: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      let ehDelete = false;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "lt", "lte", "is", "in", "order", "limit", "range", "update"]) {
        q[m] = () => q;
      }
      q.delete = () => ((ehDelete = true), q);
      q.then = (r: (v: unknown) => unknown) =>
        Promise.resolve(
          ehDelete && recusam.includes(tabela)
            ? { data: null, error: { message: "permission denied" } }
            : { data: [], error: null },
        ).then(r);
      return q;
    },
  }),
}));

async function rodada(): Promise<Response> {
  const { GET } = await import("@/app/api/v1/cron/webhook-log-retention/route");
  const resposta = await GET({
    url: "http://localhost/api/v1/cron/webhook-log-retention",
    headers: new Headers({ authorization: "Bearer segredo" }),
  } as never);
  // O Sentry entra por import dinâmico: um tique para a promessa resolver.
  await new Promise((r) => setTimeout(r, 0));
  return resposta;
}

const podasAuditadas = () =>
  auditou.mock.calls.map((c) => (c[0] as { metadata: { poda: string } }).metadata.poda);

describe("falha persistente da poda", () => {
  beforeEach(() => {
    auditou.mockClear();
    capturou.mockClear();
    logou.mockClear();
    esquecerFalhasAvisadas();
    recusam = ["webhook_lead_captures"];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("três rodadas falhando gravam UMA linha na trilha e UM evento no Sentry", async () => {
    for (let i = 0; i < 3; i += 1) await rodada();
    expect(podasAuditadas()).toEqual(["webhook_lead_captures"]);
    expect(capturou).toHaveBeenCalledTimes(1);
  });

  it("o log de erro e o 500 continuam em TODA rodada", async () => {
    const status: number[] = [];
    for (let i = 0; i < 3; i += 1) status.push((await rodada()).status);
    expect(status).toEqual([500, 500, 500]);
    expect(logou).toHaveBeenCalledTimes(3);
  });

  it("o teto é POR PODA: a outra tabela falhando ganha a linha dela", async () => {
    await rodada();
    recusam = ["webhook_lead_captures", "webhook_events_log"];
    await rodada();
    expect(podasAuditadas().sort()).toEqual(["webhook_events_log", "webhook_lead_captures"]);
  });

  it("um dia depois, a falha que continua é dita de novo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T08:00:00Z"));
    await rodada();
    vi.setSystemTime(new Date("2026-10-06T07:55:00Z"));
    await rodada();
    expect(auditou).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-06T08:00:00Z"));
    await rodada();
    expect(auditou).toHaveBeenCalledTimes(2);
  });
});
