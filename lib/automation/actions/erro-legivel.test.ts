/**
 * O ERRO LEGÍVEL DAS AÇÕES DE AUTOMAÇÃO.
 *
 * Portado do projeto original (DeskcommCRM, PR #2986 de @webtecnica).
 *
 * Toda ação traduzia a falha com `err instanceof Error ? err.message :
 * String(err)`. O erro do PostgREST NÃO é `Error` — é o objeto
 * `{ code, message, details, hint }` do supabase-js —, e o `String(err)` gravava
 * `"[object Object]"` no registro da execução (aba Atividade).
 *
 * Prova-se o HELPER e dois CAMINHOS REAIS de `send_ai_message` em que a
 * dependência rejeita com o objeto do PostgREST.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { mensagemDeErro } from "@/lib/automation/actions/erro-legivel";

/** O objeto EXATO que o supabase-js põe em `error` — NÃO é `Error`. */
const ERRO_DO_POSTGREST = {
  code: "PGRST301",
  details: "JWT expired",
  hint: null,
  message: "JWT expired",
};

describe("mensagemDeErro — extrai o motivo do objeto que o `String()` apagava", () => {
  it("anti-vacuidade: o input deste arquivo é o que virava `[object Object]`", () => {
    expect(String(ERRO_DO_POSTGREST)).toBe("[object Object]");
  });

  it("objeto do PostgREST: diz a mensagem e o código", () => {
    const texto = mensagemDeErro(ERRO_DO_POSTGREST);
    expect(texto).not.toContain("[object Object]");
    expect(texto).toContain("JWT expired");
    expect(texto).toContain("PGRST301");
  });

  it("`Error` continua saindo como `err.message`", () => {
    expect(mensagemDeErro(new Error("pool esgotado"))).toBe("pool esgotado");
  });

  it("`Error` com `code` acrescenta o código", () => {
    const erro = Object.assign(new Error("falha de rede"), { code: "ETIMEDOUT" });
    expect(mensagemDeErro(erro)).toBe("falha de rede — código ETIMEDOUT");
  });

  it("primitivos caem para `String`", () => {
    expect(mensagemDeErro("texto cru")).toBe("texto cru");
    expect(mensagemDeErro(42)).toBe("42");
    expect(mensagemDeErro(undefined)).toBe("undefined");
  });

  it("objeto vazio e circular têm texto explícito; objeto sem mensagem nunca grava valores", () => {
    expect(mensagemDeErro({})).toBe("erro sem mensagem");
    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(mensagemDeErro(circular)).toBe("erro sem mensagem (campos: eu)");
    const comToken = mensagemDeErro({ headers: { authorization: "Bearer tok_x" } });
    expect(comToken).not.toContain("tok_x");
    expect(comToken).toContain("headers");
  });

  it("o `code` numérico legado do DOMException não vira 'código 23'", () => {
    const erro = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(mensagemDeErro(erro)).toBe("The operation was aborted due to timeout");
  });

  it("o `limite` trunca sem reintroduzir o defeito", () => {
    expect(mensagemDeErro(ERRO_DO_POSTGREST, 4)).toBe("JWT ");
  });
});

// ─── Caminhos REAIS de send_ai_message ───────────────────────────────────────

const serviceForAutomation = vi.fn();
const decidirPreGoLiveDoCanalViaSupabase = vi.fn();

vi.mock("@/lib/automation/guarda-do-contato", () => ({
  checarGuardasDeContato: () => ({
    ok: true,
    contact: { id: "contato-1", name: "Contato de Teste", phone_number: "+5511999998888" },
  }),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pre-go-live", () => ({
  decidirPreGoLiveDoCanalViaSupabase: (...args: unknown[]) => decidirPreGoLiveDoCanalViaSupabase(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/automation/throttle", () => ({
  espacarEnvio: vi.fn(async () => undefined),
  checkDailyLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({ gerarAbordagemDeFormulario: vi.fn() }));
vi.mock("@/lib/automation/dados-do-formulario", () => ({
  dadosDoFormularioDoContexto: vi.fn(async () => ({ dados: {}, origem: null, origemDaAbordagem: null })),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  serviceForAutomation: (...args: unknown[]) => serviceForAutomation(...args),
  originFromAutomationEvent: vi.fn(async () => null),
}));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-ai-message";

/** Admin mínimo: a leitura da marca do contato devolve "sem marca". */
function adminFalso(): ActionCtx["admin"] {
  const encadeavel: Record<string, unknown> = {};
  for (const metodo of ["select", "eq"]) encadeavel[metodo] = () => encadeavel;
  encadeavel.maybeSingle = async () => ({ data: {}, error: null });
  return { from: () => encadeavel } as unknown as ActionCtx["admin"];
}

function ctxDeEnvio(): ActionCtx {
  return {
    admin: adminFalso(),
    organizationId: "11111111-1111-4111-8111-111111111111",
    ruleId: "regra-1",
    ruleName: "Automação de teste",
    requestId: "req-1",
    event: {} as ActionCtx["event"],
    context: { contact: { id: "contato-1", phone_number: "+5511999998888" } },
  } as ActionCtx;
}

const CONFIG_IA = {
  channel_session_id: "22222222-2222-4222-8222-222222222222",
  agent_id: "agente-1",
  instruction: "Cumprimente e pergunte o bairro.",
};

function executar(ctx: ActionCtx): Promise<ActionResultDetail> {
  const acao = getAction("send_ai_message");
  if (!acao) throw new Error("send_ai_message não está registrada");
  return acao.execute(ctx, CONFIG_IA);
}

beforeEach(() => {
  vi.clearAllMocks();
  decidirPreGoLiveDoCanalViaSupabase.mockResolvedValue({ permite: true });
});

describe("send_ai_message não registra erro sem motivo", () => {
  it("a guarda de pré-go-live rejeita com o objeto do PostgREST", async () => {
    decidirPreGoLiveDoCanalViaSupabase.mockRejectedValue(ERRO_DO_POSTGREST);
    const r = await executar(ctxDeEnvio());
    expect(r).toMatchObject({ status: "skipped", detail: { reason: "elegibilidade_indeterminada" } });
    expect((r.detail as { error?: string }).error).toContain("JWT expired");
  });

  it("a resolução da fronteira rejeita com o objeto do PostgREST", async () => {
    serviceForAutomation.mockRejectedValue(ERRO_DO_POSTGREST);
    const r = await executar(ctxDeEnvio());
    expect(JSON.stringify(r)).not.toContain("[object Object]");
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toContain("JWT expired");
  });
});
