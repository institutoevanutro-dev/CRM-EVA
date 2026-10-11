/**
 * {{nome}} e {{primeiro_nome}} no worker: o texto e o modelo do passo saem com
 * o nome do contato (o `name`, depois o `display_name` do perfil) lido NA HORA
 * do envio; sem nome, a variável sai do texto. {{volta}} segue funcionando.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as FollowupTurnModule from "@/lib/agent-engine/agent/followup-turn";
import type * as InboundTurnModule from "@/lib/agent-engine/agent/inbound-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const runBeforeSend = vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  status: "sent",
  outcome: { kind: "sent" },
  trace: [],
}));
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

const runAgentTurn = vi.fn(async () => undefined);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const ENR = "11111111-1111-4111-8111-111111111111";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: "job-1", organization_id: ORG, contact_id: LEAD, kind: "followup_turn", source_event_id: null,
    payload: { followup_enrollment_id: ENR, node_id: "node-1", purpose: "send_message", ...payload, service_boundary: boundary },
    status: "running", priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: "w1", locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

function fakePool(contato: Record<string, string | null>, modelo = "Olá {{nome}}") {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/c\.display_name/.test(sql)) {
      // O filtro por organização é obrigatório: service role não tem RLS.
      expect(params).toEqual([ORG, LEAD]);
      return { rows: [contato] };
    }
    if (/from message_templates/.test(sql)) return { rows: [{ body: modelo }] };
    // A inscrição viva no mesmo nó (guarda da #2261 no início do turno).
    if (sql.includes("select current_node_id, status from followup_enrollments")) return { rows: [{ current_node_id: "node-1", status: "active" }], rowCount: 1 };
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: "canal-1", archived_at: null, bot_silenciado: false,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(), humano_respondeu: false, atribuida_a_pessoa: false,
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

const warn = vi.fn();
function deps() {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  return {
    complete,
    deps: {
      log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send: vi.fn(async () => ({ kind: "sent" })) }),
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
  runBeforeSend.mockClear();
  runAgentTurn.mockClear();
  warn.mockClear();
});

const corpoEnviado = () => (runBeforeSend.mock.calls[0]?.[0] as { body?: string } | undefined)?.body;

describe("worker — variáveis do contato no texto e no modelo do passo", () => {
  it("texto: {{primeiro_nome}} vira o primeiro nome do perfil (display_name) quando não há name", async () => {
    await criarHandler(deps().deps)(
      job({ fixed_body: "Ei, {{primeiro_nome}}, tá por aí?" }),
      fakePool({ name: null, display_name: "João Lima" }),
      ctx,
    );
    expect(corpoEnviado()).toBe("Ei, João, tá por aí?");
  });

  it("texto sem nome nenhum: a variável sai do texto", async () => {
    await criarHandler(deps().deps)(
      job({ fixed_body: "Ei, {{primeiro_nome}}, tá por aí?" }),
      fakePool({ name: null, display_name: null }),
      ctx,
    );
    expect(corpoEnviado()).toBe("Ei, tá por aí?");
  });

  it("modelo: {{nome}} do message_templates vira o nome inteiro", async () => {
    await criarHandler(deps().deps)(
      job({ template_id: "33333333-3333-4333-8333-333333333333" }),
      fakePool({ name: null, display_name: "João Lima" }),
      ctx,
    );
    expect(corpoEnviado()).toBe("Olá João Lima");
  });

  it("texto que era só {{primeiro_nome}}, sem nome: não envia '' — pula o passo com motivo legível", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "{{primeiro_nome}}" }), fakePool({ name: null, display_name: null }), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: { kind: "pulado", reason: "Passo pulado: as variáveis ficaram sem valor e a mensagem ficaria vazia." },
      }),
    );
  });

  it("{{volta}} continua funcionando junto", async () => {
    await criarHandler(deps().deps)(
      job({ fixed_body: "{{nome}}, tentativa {{volta}} de {{voltas}}", volta_index: 2, volta_total: 3 }),
      fakePool({ name: "Bia Ramos", display_name: null }),
      ctx,
    );
    expect(corpoEnviado()).toBe("Bia Ramos, tentativa 2 de 3");
  });

  const PESSOA = { name: "Bia Ramos", display_name: null, phone_number: "+5527999990000", email: "bia@exemplo.com", lead_title: "Avaliação" };

  it("texto: telefone, e-mail e o título do negócio saem preenchidos", async () => {
    await criarHandler(deps().deps)(
      job({ fixed_body: "{{primeiro_nome}}, falo no {{telefone}} ou em {{contact.email}} sobre {{lead.title}}?" }),
      fakePool(PESSOA),
      ctx,
    );
    expect(corpoEnviado()).toBe("Bia, falo no +5527999990000 ou em bia@exemplo.com sobre Avaliação?");
  });

  it("modelo: variável sem valor sai do texto, sem chaves, 'null' nem 'undefined'", async () => {
    await criarHandler(deps().deps)(
      job({ template_id: "33333333-3333-4333-8333-333333333333" }),
      fakePool({ ...PESSOA, email: null, lead_title: null }, "Oi {{nome}}, seu e-mail é {{email}}? ({{lead.title}})"),
      ctx,
    );
    expect(corpoEnviado()).toBe("Oi Bia Ramos, seu e-mail é?");
  });

  it("variável desconhecida (erro de digitação) sai do texto e vira aviso no log, sem o dado do paciente", async () => {
    await criarHandler(deps().deps)(
      job({ fixed_body: "Oi {{nomee}}, tudo bem? {{contact.birthdate}}" }),
      fakePool(PESSOA),
      ctx,
    );
    expect(corpoEnviado()).toBe("Oi, tudo bem?");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("variável desconhecida"),
      expect.objectContaining({ variaveis: ["{{nomee}}", "{{contact.birthdate}}"] }),
    );
  });

  it("texto só com variável desconhecida: pula o passo em vez de mandar chaves", async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: "{{nomee}}" }), fakePool(PESSOA), ctx);
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(d.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: expect.objectContaining({ kind: "pulado" }) }),
    );
  });
});
