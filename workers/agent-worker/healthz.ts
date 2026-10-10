/**
 * `/healthz` + `/metrics` do worker do agent-engine.
 *
 * Mora num módulo próprio porque o `main.ts` chama `main()` no TOPO do módulo
 * (é entrypoint do `tsx`): importá-lo num teste subiria o worker inteiro. Fora
 * de lá, dá para travar o laço do drain num teste e provar, pela porta de
 * verdade, que o `/healthz` responde não saudável depois do limite.
 *
 * O laço do drain da IA é informação de PRIMEIRA classe: além do campo
 * `ia_drain` em todos os ramos, o carimbo vencido vira **503**. Porte do
 * upstream melgarafael/DeskcommCRM#2691.
 */
import http from "node:http";

import type pg from "pg";

import { prontidaoDoDrainDaIa } from "@/lib/agent-engine/edge/crm/drain";
import { sessionHealthMetrics } from "@/lib/agent-engine/edge/crm/session-watchdog";
import { prontidaoDoLacoDeEventLog } from "@/lib/event-log/drain-loop";
import { metricsSnapshot } from "@/lib/agent-engine/obs/metrics";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Mesma disciplina da fila: 1ª linha truncada, PII fora. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

/** /healthz + /metrics do worker (bind 0.0.0.0 — o container expõe a porta). */
export function createHealthzServer(
  pool: pg.Pool,
  log: Logger,
  metricsWindowMs: number,
): http.Server {
  const respond = (res: http.ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const route = (req.url ?? "").split("?", 1)[0];
    if (req.method !== "GET" || (route !== "/healthz" && route !== "/metrics")) {
      respond(res, 404, { error: "not_found" });
      return;
    }
    if (route === "/metrics") {
      try {
        respond(res, 200, await metricsSnapshot(pool, metricsWindowMs));
      } catch (err) {
        log.error("metrics: snapshot indisponível", { error: errMsg(err) });
        respond(res, 503, { status: "degraded", db: "error" });
      }
      return;
    }
    const uptime_s = Math.round(process.uptime());
    // Lido ANTES do banco: o carimbo do laço não depende do Postgres responder,
    // e é justamente quando ele não responde que o carimbo envelhece.
    const ia_drain = prontidaoDoDrainDaIa();
    try {
      const { rows } = await pool.query<{ status: string; n: number }>(
        "select status, count(*)::int as n from job_queue group by status",
      );
      const queue = { pending: 0, running: 0, dead: 0 };
      for (const row of rows) {
        if (row.status in queue) queue[row.status as keyof typeof queue] = row.n;
      }
      const sessions = await sessionHealthMetrics(pool);
      // O laço do event_log é informação de saúde de PRIMEIRA classe (#604): na
      // #648 este mesmo handler respondia 200 com o laço parado havia dez dias.
      // `event_log_drain` vai em TODOS os ramos, de propósito — a
      // prontidão do laço não depende do banco estar de pé, e é ela que o gate
      // de publicação exige antes de publicar.
      if (ia_drain.parado) {
        // Carimbo vencido = o laço do drain da IA travou NO MEIO de uma volta:
        // as mensagens chegam e nenhum turno é enfileirado. É 503 de propósito,
        // para o `docker compose ps` mostrar `unhealthy`. Laço OCIOSO nunca cai
        // aqui: volta vazia também carimba (ver `runDrainLoop`).
        respond(res, 503, {
          status: "degraded",
          db: "ok",
          queue,
          sessions,
          ia_drain,
          event_log_drain: prontidaoDoLacoDeEventLog(),
          uptime_s,
        });
        return;
      }
      respond(res, 200, {
        status: "ok",
        db: "ok",
        queue,
        sessions,
        ia_drain,
        event_log_drain: prontidaoDoLacoDeEventLog(),
        uptime_s,
      });
    } catch (err) {
      log.error("healthz: banco indisponível", { error: errMsg(err) });
      respond(res, 503, {
        status: "degraded",
        db: "error",
        queue: null,
        sessions: null,
        // Mesmo com o banco fora, a prontidão do laço aparece: é ela que o gate
        // de publicação (#604) lê antes de deixar as imagens irem para o canal.
        ia_drain,
        event_log_drain: prontidaoDoLacoDeEventLog(),
        uptime_s,
      });
    }
  };
  return http.createServer((req, res) => void handle(req, res));
}
