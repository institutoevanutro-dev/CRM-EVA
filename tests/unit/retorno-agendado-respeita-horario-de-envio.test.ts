/**
 * O RETORNO AGENDADO (sem fluxo) RESPEITA O "HORÁRIO DE ENVIO" DA ORGANIZAÇÃO.
 *
 * Os fluxos já adiam fora da janela (`conferirAntesDoEnvio`); o retorno que a IA
 * prometeu passava direto. Pedido de 20/11/2026: sem follow-up no sábado. Fora
 * da janela o turno é REAGENDADO para a próxima abertura — nunca descartado — e
 * dentro dela segue como antes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};
// Domingo a sexta, 9h às 20h (sem sábado).
const SEM_SABADO = {
  followups: {
    bloqueios: {
      janela: { timezone: "America/Sao_Paulo", dias: [0, 1, 2, 3, 4, 5], intervalos: [{ inicio: "09:00", fim: "20:00" }] },
    },
  },
};

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      reason: "retorno combinado",
      promise: "te chamo para confirmar",
      promised_at: "2026-11-21T13:00:00.000Z",
      service_boundary: boundary,
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

let settings: unknown = SEM_SABADO;
let crons: Array<{ next_run_at: unknown }> = [];
function fakePool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/insert into cron_jobs/.test(sql)) {
      crons.push({ next_run_at: params?.[8] });
      return { rows: [{}], rowCount: 1 };
    }
    if (/select settings from organizations/.test(sql)) return { rows: [{ settings }], rowCount: 1 };
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql)) return { rows: [{ channel_session_id: "canal-1", archived_at: null }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps(agora: string) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    channel: () => ({ send: vi.fn() }),
    clock: () => new Date(agora),
  } as never;
}

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => {
  settings = SEM_SABADO;
  crons = [];
  runAgentTurn.mockClear();
});

describe("retorno agendado diante do horário de envio da organização", () => {
  it("⭐ sábado 10h: não fala e é reagendado para domingo 9h (nunca descartado)", async () => {
    await criarHandler(deps("2026-11-21T13:00:00.000Z"))(job(), fakePool(), { workerId: "w1" });
    expect(runAgentTurn, "o retorno saiu no sábado").not.toHaveBeenCalled();
    expect(crons).toHaveLength(1);
    expect(new Date(crons[0]!.next_run_at as string).toISOString()).toBe("2026-11-22T12:00:00.000Z");
  });

  it("sexta 10h (dentro da janela): segue como antes", async () => {
    await criarHandler(deps("2026-11-20T13:00:00.000Z"))(job(), fakePool(), { workerId: "w1" });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(crons).toHaveLength(0);
  });

  it("organização sem horário de envio: segue como antes", async () => {
    settings = {};
    await criarHandler(deps("2026-11-21T13:00:00.000Z"))(job(), fakePool(), { workerId: "w1" });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
});
