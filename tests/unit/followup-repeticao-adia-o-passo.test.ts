/**
 * TEXTO FIXO DO FLUXO VETADO SÓ PELA TRAVA DE REPETIÇÃO NÃO CANCELA A INSCRIÇÃO.
 *
 * O defeito: etapa de pós-consulta ancorada no dia sai às 08:00 para todos os
 * pacientes do dia. A trava de repetição (`spinning`, code `mass_identical`)
 * veta a 3ª cópia quase igual — e o turno gravava `skipped`, que CANCELA a
 * inscrição inteira: o paciente perdia também os passos seguintes.
 *
 * O conserto: veto SÓ do spinning adia o passo 5–30 min (job re-agendado pela
 * cadeia inteira de novo, então a janela continua valendo), trocando para a
 * redação seguinte quando o passo tem variantes, até
 * `MAX_ADIAMENTOS_POR_REPETICAO`. Esgotado, o desfecho terminal de sempre.
 * Veto de qualquer OUTRO gate continua cancelando como antes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BloqueiosModule from "@/lib/followup/bloqueios-obrigatorios";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const AGORA = new Date("2026-10-20T11:00:00.000Z");

const chain = vi.fn();
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: (args: Record<string, unknown>) => chain(args),
}));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/followup/bloqueios-obrigatorios", async (original) => {
  const real = await original<typeof BloqueiosModule>();
  return { ...real, conferirAntesDoEnvio: async () => ({ envia: true }) };
});
vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({ applySendOutcome: vi.fn(async () => undefined) }));
const scheduleCronJob = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ scheduleCronJob: (...a: unknown[]) => scheduleCronJob(...a) }));

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

const REDACOES = ["Oi! Como você está depois da consulta?", "Olá! Passando para saber como foi sua semana.", "Bom dia! Tudo certo desde a consulta?"];

function job(extra: Record<string, unknown> = {}): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      followup_enrollment_id: "11111111-1111-4111-8111-111111111111",
      node_id: "a1",
      purpose: "send_message",
      fixed_body: REDACOES[1],
      variante: 1,
      variantes: REDACOES,
      service_boundary: boundary,
      ...extra,
    },
    status: "running",
    priority: 0,
    run_after: AGORA,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: AGORA,
    created_at: AGORA,
  } as JobRow;
}

function fakePool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (sql.includes("select current_node_id, status from followup_enrollments")) return { rows: [{ current_node_id: "a1", status: "active" }], rowCount: 1 };
    if (/from conversations/.test(sql)) {
      return { rows: [{ id: CONVERSA, channel_session_id: "canal-1", archived_at: null, provider: DEFAULT_CHANNEL_PROVIDER }] };
    }
    if (/from contacts/.test(sql)) return { rows: [{ is_blocked: false, name: "Paciente Teste" }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

const veto = (code: string) => ({ status: "vetoed", gate: code === "mass_identical" ? "spinning" : "stop", code, message: "x", trace: [] });

let mod: typeof import("@/lib/agent-engine/agent/followup-turn");
beforeAll(async () => {
  mod = await import("@/lib/agent-engine/agent/followup-turn");
}, 60_000);
beforeEach(() => {
  chain.mockReset();
  scheduleCronJob.mockClear();
});

async function rodar(j: JobRow) {
  const completeFollowupTurn = vi.fn(async (..._a: unknown[]) => undefined);
  const deps = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    crmCfg: {},
    llmCfg: {},
    knobs: {},
    clock: () => AGORA,
    channel: () => ({ send: vi.fn(async () => ({ ok: true })) }),
    completeFollowupTurn,
  } as never;
  await mod.createFollowupTurnHandler(deps)(j, fakePool(), { workerId: "w1" });
  expect(completeFollowupTurn).toHaveBeenCalledTimes(1);
  return (completeFollowupTurn.mock.calls[0]![1] as { result: { kind: string; until?: Date; reason?: string } }).result;
}

describe("trava de repetição no texto fixo do fluxo", () => {
  it("⭐ veto só do spinning ADIA 5–30 min com a redação seguinte, sem cancelar", async () => {
    chain.mockResolvedValue(veto("mass_identical"));
    const result = await rodar(job());

    expect(result.kind, "o veto de repetição cancelou a inscrição").toBe("deferred");
    expect(result.reason).toBe("mass_identical");
    const atraso = result.until!.getTime() - AGORA.getTime();
    expect(atraso).toBeGreaterThanOrEqual(mod.ATRASO_DA_REPETICAO_MS.min);
    expect(atraso).toBeLessThan(mod.ATRASO_DA_REPETICAO_MS.max);

    expect(scheduleCronJob).toHaveBeenCalledTimes(1);
    const agendado = scheduleCronJob.mock.calls[0]![2] as { spec: { at: Date }; payload: Record<string, unknown> };
    expect(agendado.spec.at.toISOString()).toBe(result.until!.toISOString());
    expect(agendado.payload.tentativa_repetida).toBe(1);
    expect(agendado.payload.variante).toBe(2);
    expect(agendado.payload.fixed_body).toBe(REDACOES[2]);
  });

  it("sem variantes adia com o mesmo texto", async () => {
    chain.mockResolvedValue(veto("mass_identical"));
    const result = await rodar(job({ variantes: undefined, variante: undefined, fixed_body: "Texto único do passo, sem variações." }));
    expect(result.kind).toBe("deferred");
    const agendado = scheduleCronJob.mock.calls[0]![2] as { payload: Record<string, unknown> };
    expect(agendado.payload.fixed_body).toBe("Texto único do passo, sem variações.");
  });

  it("esgotado o limite de adiamentos, o desfecho terminal de sempre", async () => {
    chain.mockResolvedValue(veto("mass_identical"));
    const result = await rodar(job({ tentativa_repetida: mod.MAX_ADIAMENTOS_POR_REPETICAO }));
    expect(result.kind).toBe("skipped");
    expect(scheduleCronJob).not.toHaveBeenCalled();
  });

  it("veto de OUTRO gate continua cancelando", async () => {
    chain.mockResolvedValue(veto("stop_detected"));
    const result = await rodar(job());
    expect(result.kind).toBe("skipped");
    expect(scheduleCronJob).not.toHaveBeenCalled();
  });
});
