import { afterEach, describe, expect, it, vi } from "vitest";

import { fail } from "./wrappers";

/**
 * M2 (auditoria 2026-09-29): ~400 chamadas `fail("internal_error", err.message, 500)`
 * devolviam a mensagem do Postgres à tela (nome de tabela, constraint, valor).
 * Em produção o 500 vira genérico e a mensagem real vai para o log, com o
 * X-Request-Id que a tela também recebe.
 */
describe("fail() — 500 em produção não vaza a mensagem interna", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("produção: 500 devolve mensagem genérica, sem details, e loga a real", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fail("internal_error", 'duplicate key value violates unique constraint "contacts_phone"', 500, {
      details: { hint: "Key (phone)=(5511999990000)" }, requestId: "req-42",
    });
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).not.toMatch(/constraint|5511/);
    expect(body.error.details).toBeUndefined();
    expect(res.headers.get("X-Request-Id")).toBe("req-42");
    expect(String(log.mock.calls[0])).toMatch(/contacts_phone/);
    log.mockRestore();
  });

  it("produção: 4xx segue com a mensagem escrita para a pessoa", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const body = await fail("validation_error", "Telefone inválido", 422, { details: { f: 1 } }).json();
    expect(body.error).toEqual({ code: "validation_error", message: "Telefone inválido", details: { f: 1 } });
  });

  it("fora de produção a mensagem real continua (diagnóstico local)", async () => {
    const body = await fail("internal_error", "boom do banco", 500).json();
    expect(body.error.message).toBe("boom do banco");
  });
});
