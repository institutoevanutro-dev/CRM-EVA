/**
 * Modelo de reserva do passo `ai_message`: a tela promete "se a IA não
 * conseguir escrever, mandar este modelo" e a publicação o exige em caminhos de
 * 24h+. Ele sai, pelas MESMAS travas do texto fixo, quando a IA não conseguiu
 * enviar: todos os envios dela vetados pela cadeia, ou erro na última tentativa
 * sem nada aceito nem na fila do canal. A IA que concluiu sem enviar (ledger
 * vazio — inclusive agente pausado ou assistido) NÃO dispara a reserva: foi
 * decisão, não falha.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FollowupTurnModule from "@/lib/agent-engine/agent/followup-turn";
import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import { TEXTO_DO_BLOQUEIO } from "@/lib/followup/bloqueios-obrigatorios";

type Cadeia = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const enviaPeloCanal: Cadeia = async (args) => {
  await (args.send as (b: string) => Promise<unknown>)(args.body as string);
  return { status: "sent", outcome: { kind: "sent" }, trace: [] };
};
const runBeforeSend = vi.fn<Cadeia>(enviaPeloCanal);
vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/agent-engine/edge/crm/send-message", () => ({ applySendOutcome: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ scheduleCronJob: vi.fn(async () => undefined) }));

const runAgentTurn = vi.fn(async (..._a: unknown[]): Promise<void> => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const ENR = "11111111-1111-4111-8111-111111111111";
const RESERVA = "33333333-3333-4333-8333-333333333333";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };
const VETADO = "O envio foi recusado pelas regras do atendimento.";
const RECUSADA = "A IA não enviou a mensagem e o modelo de reserva também foi recusado pelas regras do atendimento.";

function job(payload: Record<string, unknown> = {}, tentativas: { attempts?: number; max_attempts?: number } = {}): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: {
      followup_enrollment_id: ENR, node_id: "node-1", purpose: "send_message", prompt_hint: "retome",
      fallback_template_id: RESERVA, ...payload, service_boundary: boundary,
    },
    status: "running", priority: 0, run_after: new Date(), attempts: tentativas.attempts ?? 1,
    max_attempts: tentativas.max_attempts ?? 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

interface Cenario {
  /** Linhas do ledger do job depois do turno da IA (resultadoDoEnvioDoFollowup e a guarda do erro). */
  ledger?: Array<{ status: string; error_code?: string | null }>;
  /** A reserva já aceita numa tentativa anterior (seq 1000). */
  reservaAceita?: boolean;
  /** `humano_respondeu` na 1ª, 2ª… leitura da conversa. */
  humano?: boolean[];
  /** Canal em allowlist e contato sem autorização: o número não está liberado. */
  naoLiberado?: boolean;
}

function fakePool(c: Cenario = {}) {
  let leiturasDaConversa = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/select \* from send_ledger where organization_id=\$1 and job_id=\$2 and seq=\$3/.test(sql)) {
      return { rows: params?.[2] === 1000 && c.reservaAceita ? [{ id: "l-1000", status: "accepted", crm_message_id: "m-1" }] : [] };
    }
    if (/from send_ledger/.test(sql)) return { rows: (c.ledger ?? []).map((r) => ({ error_code: null, ...r })) };
    if (/select name, display_name from contacts/.test(sql)) return { rows: [{ name: "Ana Souza", display_name: null }] };
    if (/from message_templates/.test(sql)) return { rows: [{ body: "Oi {{primeiro_nome}}, ainda posso ajudar?" }] };
    if (/from conversations/.test(sql)) {
      const humano = c.humano?.[leiturasDaConversa] ?? false;
      if (/humano_respondeu/.test(sql)) leiturasDaConversa += 1;
      return { rows: [{
        id: CONVERSA, channel_session_id: "canal-1", archived_at: null, bot_silenciado: false,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(), humano_respondeu: humano, atribuida_a_pessoa: false,
        canal_metadata: c.naoLiberado ? { ai_gate: "allowlist" } : null,
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: "active", started_at: new Date(0), pointer_id: "22222222-2222-4222-8222-222222222222",
        trigger_config: null, handoff_policy: "pause", appointment_id: null,
      }] };
    }
    if (/from contacts/.test(sql)) return { rows: [{ is_blocked: false, force_human: false, is_anonymized: false }] };
    if (/from organizations/.test(sql)) return { rows: [{ settings: {} }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps() {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  const send = vi.fn(async (..._a: unknown[]) => ({ kind: "sent" }));
  return {
    complete,
    send,
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send }),
      completeFollowupTurn: complete,
    } as never,
  };
}

const ctx = { workerId: "w1" };
let criarHandler: typeof FollowupTurnModule.createFollowupTurnHandler;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);
beforeEach(() => {
  runBeforeSend.mockReset();
  runBeforeSend.mockImplementation(enviaPeloCanal);
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue(undefined);
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;
const RESERVA_SAIU = { kind: "sent", via: "modelo_de_reserva" };

describe("modelo de reserva — quando a IA não conseguiu enviar", () => {
  it("1. todos os envios da IA vetados, travas limpas → a reserva sai interpolada, com seq 1000", async () => {
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "vetoed" }] }), ctx);
    expect(runBeforeSend).toHaveBeenCalledTimes(1);
    expect(runBeforeSend.mock.calls[0]![0]).toMatchObject({ body: "Oi Ana, ainda posso ajudar?" });
    expect(d.send).toHaveBeenCalledWith(expect.objectContaining({ seq: 1000 }));
    expect(resultado(d.complete)).toEqual(RESERVA_SAIU);
  });

  it("2. a IA enviou → a reserva não é tentada (controle)", async () => {
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "accepted" }] }), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "sent" });
  });

  it("3. uma pessoa respondeu durante o turno → a reserva não sai; encerra com handoff", async () => {
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "vetoed" }], humano: [false, true] }), ctx);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome: "handoff" });
  });

  it("4. número não liberado (allowlist sem autorização) → nem a IA nem a reserva; encerra com o motivo", async () => {
    // O gate do canal é parte da decisão compartilhada: barra antes do turno,
    // com o mesmo motivo que o atalho do texto fixo daria.
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "vetoed" }], naoLiberado: true }), ctx);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: TEXTO_DO_BLOQUEIO.conversa_nao_liberada });
  });

  it("5. a reserva também vetada pela cadeia → encerra com o motivo das duas recusas", async () => {
    runBeforeSend.mockResolvedValue({ status: "vetoed", code: "repetition", trace: [] });
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "vetoed" }] }), ctx);
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: RECUSADA });
  });

  it("6. a reserva adiada pela janela anti-ban → o passo não fecha", async () => {
    runBeforeSend.mockResolvedValue({ status: "vetoed", code: "outside_window", nextAllowedAt: new Date(Date.now() + 3_600_000), trace: [] });
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [{ status: "vetoed" }] }), ctx);
    expect(d.complete).not.toHaveBeenCalled();
  });

  describe("7. a IA lançou", () => {
    it("antes da última tentativa → relança; a reserva não é tentada", async () => {
      runAgentTurn.mockRejectedValue(new Error("llm"));
      const d = deps();
      await expect(criarHandler(d.deps)(job({}, { attempts: 1, max_attempts: 3 }), fakePool(), ctx)).rejects.toThrow("llm");
      expect(runBeforeSend).not.toHaveBeenCalled();
    });

    it("na última tentativa, nada aceito nem na fila → a reserva sai", async () => {
      runAgentTurn.mockRejectedValue(new Error("llm"));
      const d = deps();
      await criarHandler(d.deps)(job({}, { attempts: 3, max_attempts: 3 }), fakePool(), ctx);
      expect(resultado(d.complete)).toEqual(RESERVA_SAIU);
    });

    it("na última tentativa, com mensagem da IA na fila do canal (queued) → a reserva NÃO sai; relança", async () => {
      runAgentTurn.mockRejectedValue(new Error("followup_message_not_sent"));
      const d = deps();
      await expect(
        criarHandler(d.deps)(job({}, { attempts: 3, max_attempts: 3 }), fakePool({ ledger: [{ status: "queued" }] }), ctx),
      ).rejects.toThrow("followup_message_not_sent");
      expect(runBeforeSend).not.toHaveBeenCalled();
    });

    it("na última tentativa e a reserva também vetada → relança o erro original", async () => {
      runAgentTurn.mockRejectedValue(new Error("llm"));
      runBeforeSend.mockResolvedValue({ status: "vetoed", code: "repetition", trace: [] });
      const d = deps();
      await expect(criarHandler(d.deps)(job({}, { attempts: 3, max_attempts: 3 }), fakePool(), ctx)).rejects.toThrow("llm");
      expect(d.complete).not.toHaveBeenCalled();
    });
  });

  it("8. erros terminais da fila (janela, agenda, fronteira, veto permanente) relançam sem reserva", async () => {
    const { JobSettledError } = await import("@/lib/agent-engine/agent/inbound-turn");
    const terminais: Error[] = [
      new JobSettledError("janela"),
      new AgendaDeferredError({ motivo: "consulta_proxima" } as never),
      new StaleServiceBoundaryError(),
      Object.assign(new Error("orçamento"), { terminal: true }),
    ];
    for (const erro of terminais) {
      runAgentTurn.mockRejectedValueOnce(erro);
      const d = deps();
      await expect(criarHandler(d.deps)(job({}, { attempts: 3, max_attempts: 3 }), fakePool(), ctx)).rejects.toBe(erro);
    }
    expect(runBeforeSend).not.toHaveBeenCalled();
  });

  it("9. retry depois de queda com a reserva já aceita → fecha como reserva sem chamar a IA", async () => {
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ reservaAceita: true }), ctx);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual(RESERVA_SAIU);
  });

  it("10. sem modelo de reserva → o comportamento de hoje", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fallback_template_id: undefined }), fakePool({ ledger: [{ status: "vetoed" }] }), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: "skipped", reason: VETADO });
  });

  it("11. a IA concluiu sem enviar (ledger vazio: decidiu não falar, agente pausado/assistido) → a reserva NÃO sai", async () => {
    const d = deps();
    await criarHandler(d.deps)(job(), fakePool({ ledger: [] }), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toMatchObject({ kind: "skipped" });
  });
});
