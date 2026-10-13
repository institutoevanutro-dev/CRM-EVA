/**
 * COMPROMISSO OBSOLETO É 409, COM O CÓDIGO NOVO E COM O ANTIGO.
 *
 * `fn_appointment_change` recusa quando a revisão enviada não é mais a do
 * compromisso (`appointment_stale`). Desde a migration 0358 (porte do upstream
 * melgarafael/DeskcommCRM#2805) essa recusa sai como `PT409`; antes saía como
 * `40001`. O handler tem de ler os DOIS como conflito: o banco e a imagem do app
 * não se atualizam no mesmo instante, e quem chama (a tela, o MCP e a varredura
 * de pedidos pendentes) depende do 409 para saber que "alguém mexeu no meio" e
 * não tratar como falha.
 */
import { describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { cancelarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const AGENDAMENTO = "ffffffff-0000-4000-8000-00000000000f";
const LINHA = {
  id: AGENDAMENTO,
  organization_id: ORG,
  status: "pending",
  revision: 3,
  contact_id: null,
  event_type_id: null,
  time_zone: "America/Sao_Paulo",
  starts_at: "2026-10-20T13:00:00.000Z",
  ends_at: "2026-10-20T14:00:00.000Z",
};

/** Toda leitura devolve a linha do compromisso; a RPC de alteração devolve o erro pedido. */
function supabaseQueRecusa(code: string) {
  const resposta = { data: LINHA, error: null };
  const cadeia: unknown = new Proxy(function () {}, {
    get: (_alvo, prop) => (prop === "then" ? (ok: (v: unknown) => unknown) => ok(resposta) : () => cadeia),
    apply: () => cadeia,
  });
  const rpc = vi.fn(async (nome: string) =>
    nome === "fn_appointment_change"
      ? { data: null, error: { code, message: "appointment_stale" } }
      : { data: null, error: null },
  );
  return { cliente: { from: () => cadeia, rpc } as never, rpc };
}

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "webhook_source", id: AGENDAMENTO },
  requestId: "req-1",
} as HandlerCtx;

describe("compromisso obsoleto é 409", () => {
  it.each(["PT409", "40001"])("recusa %s de fn_appointment_change vira ApiError 409 (conflict)", async (code) => {
    const { cliente, rpc } = supabaseQueRecusa(code);
    const erro = await cancelarAgendamentoHandler(cliente, ctx, { id: AGENDAMENTO, revision: 3, reason: "teste" }).catch(
      (e: unknown) => e,
    );
    expect(rpc).toHaveBeenCalledWith("fn_appointment_change", expect.objectContaining({ p_id: AGENDAMENTO, p_revision: 3 }));
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(409);
  });

  it("controle: outro código não é conflito", async () => {
    const { cliente } = supabaseQueRecusa("23514");
    const erro = await cancelarAgendamentoHandler(cliente, ctx, { id: AGENDAMENTO, revision: 3, reason: "teste" }).catch(
      (e: unknown) => e,
    );
    expect((erro as ApiError).status).toBe(422);
  });
});
