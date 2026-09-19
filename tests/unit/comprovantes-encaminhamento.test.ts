import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  applyPreviewPolicy,
  newPreviewResult,
  previewGateContext,
  scenarioContext,
  type TurnPreview,
} from "@/lib/agent-engine/agent/preview";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { Logger } from "@/lib/agent-engine/obs/logger";

import {
  casePromiseGate,
  runBeforeSend,
  type RunBeforeSendArgs,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

function contexto(body: string, overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-09-18T15:00:00Z"),
    body,
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    unscheduledFollowUpEnforced: true,
    ...overrides,
  };
}

const ENCAMINHAMENTOS = [
  "Vou encaminhar o comprovante ao financeiro.",
  "Vou passar o comprovante à recepção.",
  "Vou conferir com o financeiro.",
  "Vou verificar com a recepção.",
  "O financeiro vai conferir o comprovante.",
  "A recepção vai te retornar.",
  "Seu comprovante está em análise pelo financeiro.",
  "Seu pedido está em análise com a recepção.",
  "Assim que a equipe conferir o comprovante, ela retorna para você.",
  "Quando o financeiro confirmar, a equipe avisa por aqui.",
];

describe("comprovantes e encaminhamentos — retaguarda nomeada pelo setor", () => {
  it.each(ENCAMINHAMENTOS)("exige caso humano: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(true);
    expect(casePromiseGate.evaluate(contexto(body))).toMatchObject({
      pass: false,
      code: "case_promise_without_case",
    });
  });

  it.each(ENCAMINHAMENTOS)("permite após registrar o caso: %s", (body) => {
    expect(casePromiseGate.evaluate(contexto(body, { hasOpenCase: true }))).toEqual({ pass: true });
    expect(casePromiseGate.evaluate(contexto(body, { openedCaseThisTurn: true }))).toEqual({
      pass: true,
    });
  });

  it.each([
    "Recebi o comprovante. O recebimento não confirma o pagamento.",
    "Vou verificar o comprovante no sistema.",
    "O financeiro funciona de segunda a sexta.",
    "A recepção está à disposição.",
    "Vou encaminhar o link. A recepção abre às nove.",
    "Vou confirmar o valor financeiro do orçamento.",
  ])("preserva fala sem promessa de encaminhamento: %s", (body) => {
    expect(detectHumanPromise(body)).toBe(false);
    expect(casePromiseGate.evaluate(contexto(body))).toEqual({ pass: true });
  });

  it.each(ENCAMINHAMENTOS)("casos desligados: pede reformulação sem abrir caso: %s", (body) => {
    expect(casePromiseGate.evaluate(contexto(body, { casesEnabled: false }))).toMatchObject({
      pass: false,
      code: "human_promise_cases_disabled",
    });
  });
});

const FRASE_REAL = "Vou pedir para a equipe conferir seu comprovante e o status do seu horário";
const REFORMULADA =
  "Recebi o comprovante. O recebimento não confirma o pagamento nem o agendamento.";
const AGORA = new Date("2026-09-18T15:00:00Z");
const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
type Estado = Pick<RunBeforeSendArgs, "casesEnabled" | "hasOpenCase" | "openedCaseThisTurn">;

/** Só as fronteiras de banco/canal são dublês; runner e TODOS os gates são reais. */
function cadeiaReal(estado: Estado = {}) {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const persist = vi.fn().mockResolvedValue({ rows: [{ id: "trace-teste" }] });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client), query: persist } as unknown as pg.Pool;
  const send = vi.fn().mockResolvedValue({ kind: "sent", idempotencyKey: "k", messageId: "m" });
  return {
    send,
    query,
    persist,
    run: (body: string) =>
      runBeforeSend({
        pool,
        log,
        tenantId: "00000000-0000-4000-8000-000000000001",
        leadId: "00000000-0000-4000-8000-000000000002",
        jobId: "00000000-0000-4000-8000-000000000003",
        channelSessionId: "00000000-0000-4000-8000-000000000004",
        body,
        optedOutThisTurn: false,
        crmDailyLimit: null,
        now: AGORA,
        rng: () => 0,
        sleep: async () => {},
        enforceUnscheduledFollowUp: true,
        send,
        ...estado,
      }),
  };
}

function exigirReformulacao(message: string) {
  expect(message).toMatch(/reformule/i);
  expect(message).not.toMatch(/open_human_case|request_human_handoff|chame|abra|abrir caso/i);
}

describe("frase do incidente — runner before-send completo", () => {
  it.each([false, true])(
    "casos=%s: veta antes do envio e persiste o motivo",
    async (casesEnabled) => {
      const f = cadeiaReal({ casesEnabled });
      const r = await f.run(FRASE_REAL);
      const code = casesEnabled ? "case_promise_without_case" : "human_promise_cases_disabled";
      expect(r).toMatchObject({ status: "vetoed", gate: "case_promise", code });
      expect(f.send).not.toHaveBeenCalled();
      expect(r.trace).toContainEqual({ gate: "case_promise", verdict: "veto", code });
      const trace = f.persist.mock.calls.find(([sql]) =>
        String(sql).includes("insert into before_send_traces"),
      );
      expect(trace?.[1]).toContain(code);
      expect(f.query).toHaveBeenCalledWith("rollback");
      if (r.status === "vetoed" && !casesEnabled) exigirReformulacao(r.message);
    },
  );

  it("repetir com casos desligados continua vetado; reformulação segura passa", async () => {
    const f = cadeiaReal({ casesEnabled: false });
    for (let n = 0; n < 3; n++) {
      expect(await f.run(FRASE_REAL)).toMatchObject({
        status: "vetoed",
        code: "human_promise_cases_disabled",
      });
    }
    expect(f.send).not.toHaveBeenCalled();
    const sqls = [...f.query.mock.calls, ...f.persist.mock.calls].map(([sql]) => String(sql));
    expect(
      sqls.some((sql) => /insert into agent_cases|insert into agent_case_events/i.test(sql)),
    ).toBe(false);
    expect(await f.run(REFORMULADA)).toMatchObject({ status: "sent" });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(REFORMULADA);
  });

  it.each([false, true])(
    "casos=%s: caso já registrado preserva o encaminhamento",
    async (casesEnabled) => {
      for (const comprovado of [{ hasOpenCase: true }, { openedCaseThisTurn: true }]) {
        const f = cadeiaReal({ casesEnabled, ...comprovado });
        expect(await f.run(FRASE_REAL)).toMatchObject({ status: "sent" });
        expect(f.send).toHaveBeenCalledExactlyOnceWith(FRASE_REAL);
      }
    },
  );

  it("caller sem configuração mantém o aviso determinístico de encaminhamento", async () => {
    const f = cadeiaReal();
    expect(await f.run("Nossa equipe vai te ajudar.")).toMatchObject({ status: "sent" });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it.each([
    "Vou tentar de novo em instantes.",
    "Vou tentar novamente daqui a pouco.",
    "Te aviso mais tarde quando conseguir confirmar.",
  ])("veta promessa de nova tentativa sem retorno programado: %s", async (body) => {
    const f = cadeiaReal({ casesEnabled: false });
    expect(await f.run(body)).toMatchObject({
      status: "vetoed",
      code: "unscheduled_followup_promise",
    });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    "Você pode tentar novamente em instantes.",
    "Se quiser, tente de novo mais tarde.",
    "Não consegui confirmar automaticamente por aqui.",
  ])("preserva orientação ou estado sem promessa futura: %s", async (body) => {
    const f = cadeiaReal({ casesEnabled: false });
    expect(await f.run(body)).toMatchObject({ status: "sent" });
    expect(f.send).toHaveBeenCalledExactlyOnceWith(body);
  });
});

/** Mesmo executor de send_message do dry-run; proposta não é execução comprovada. */
async function previaReal(casesEnabled: boolean, casoExistente = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from agent_cases")) return { rows: [{ open: casoExistente }] };
    return { rows: [] };
  });
  const p: TurnPreview = {
    kind: "sandbox",
    organizationId: "org-cenario",
    runId: "run-cenario",
    agent: { casesEnabled, handoffKeywords: [], toolIds: [] } as unknown as PublishedAgentConfig,
    context: scenarioContext([
      { direction: "inbound", body: "Enviei o comprovante.", sent_at: AGORA.toISOString() },
    ]),
    contactId: casoExistente ? "contato-cenario" : null,
    channelId: null,
    result: newPreviewResult(),
  };
  p.context.context.conversation_id = casoExistente ? "conversa-cenario" : null;
  const ctx = await previewGateContext({ query } as unknown as pg.Pool, p, log, AGORA);
  const send = vi.fn(),
    abrir = vi.fn();
  const tools = applyPreviewPolicy(
    {
      send_message: tool({ inputSchema: z.object({ body: z.string() }), execute: send }),
      open_human_case: tool({ inputSchema: z.object({}), execute: abrir }),
    },
    p,
    ctx,
    () => [],
  );
  const execute = (name: string, args: unknown) =>
    tools[name]!.execute!(args, { toolCallId: "teste", messages: [], context: undefined });
  return { p, send, abrir, execute };
}

describe("frase do incidente — dry-run e before-send compartilhado", () => {
  it.each([false, true])(
    "casos=%s: frase exata vetada; resposta segura passa",
    async (casesEnabled) => {
      const f = await previaReal(casesEnabled);
      const code = casesEnabled ? "case_promise_without_case" : "human_promise_cases_disabled";
      for (let n = 0; n < 2; n++) {
        expect(await f.execute("send_message", { body: FRASE_REAL })).toMatchObject({
          ok: false,
          error: { code },
        });
      }
      expect(f.p.result.candidates).toEqual([]);
      expect(f.p.result.proposals).toEqual([]);
      if (!casesEnabled) exigirReformulacao(f.p.result.impediments[0]!.message);
      await f.execute("send_message", { body: REFORMULADA });
      expect(f.p.result.candidates.map((c) => c.body)).toEqual([REFORMULADA]);
      expect(f.send).not.toHaveBeenCalled();
      expect(f.abrir).not.toHaveBeenCalled();
    },
  );

  it("casos habilitados: proposta de abertura não libera a promessa", async () => {
    const f = await previaReal(true);
    await f.execute("open_human_case", {});
    expect(f.p.result.proposals).toHaveLength(1);
    expect(await f.execute("send_message", { body: FRASE_REAL })).toMatchObject({
      ok: false,
      error: { code: "case_promise_without_case" },
    });
    expect(f.abrir).not.toHaveBeenCalled();
    expect(f.p.result.candidates).toEqual([]);
  });

  it.each([false, true])(
    "casos=%s: caso lido do banco libera a candidata",
    async (casesEnabled) => {
      const f = await previaReal(casesEnabled, true);
      expect(await f.execute("send_message", { body: FRASE_REAL })).toMatchObject({
        ok: true,
        status: "simulated",
      });
      expect(f.p.result.candidates[0]?.body).toBe(FRASE_REAL);
      expect(f.abrir).not.toHaveBeenCalled();
    },
  );
});
