/**
 * Issue #64 — o teto está LIGADO no login, não só disponível numa lib.
 *
 * O helper tem teste próprio (lib/auth/rate-limit.test.ts); este aqui prova a
 * fiação: a action recusa a 6ª tentativa contra a MESMA conta dentro da janela,
 * antes de falar com o GoTrue. Sem a chamada em signInWithPassword.ts, as seis
 * tentativas chegariam ao provedor e o teste fica vermelho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { configEvalink } from "@/lib/evalink/config";
import { reservaBloqueia } from "@/lib/evalink/reserva";
import { audit } from "@/lib/audit";
import { registrarFalhaDeLogin } from "@/lib/auth/rate-limit";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/evalink/config", () => ({ configEvalink: vi.fn() }));
vi.mock("@/lib/evalink/reserva", () => ({ reservaBloqueia: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
// Mantém o comportamento real (o teto de tentativas de outras suítes depende
// dele), só embrulhado em vi.fn para permitir asserção de chamada.
vi.mock("@/lib/auth/rate-limit", async (orig) => {
  const original = await orig<Record<string, unknown>>();
  return {
    ...original,
    registrarFalhaDeLogin: vi.fn(original.registrarFalhaDeLogin as (...a: unknown[]) => unknown),
  };
});
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const signIn = vi.fn(async () => ({
  data: { user: null, session: null },
  error: { message: "Invalid login credentials", status: 400 },
}));

describe("signInWithPassword — teto de tentativas", () => {
  beforeEach(() => {
    vi.resetModules();
    signIn.mockClear();
    vi.mocked(configEvalink).mockReturnValue(null);
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-forwarded-for" ? "203.0.113.77" : null),
    } as never);
    signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials", status: 400 },
    } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: signIn,
        signOut: vi.fn(async () => ({ error: null })),
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [{ id: "f1" }] } })) },
      },
    } as never);
  });

  it("recusa a 6ª tentativa contra a mesma conta sem chamar o provedor", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const input = { email: "alvo@example.com", password: "senha-errada-123" };

    const resultados = [];
    for (let i = 0; i < 6; i++) {
      resultados.push(await signInWithPassword(input));
    }

    // AUTH_LIMITS.login.id = 5 → as 5 primeiras passam do teto e falham no
    // provedor; a 6ª nem chega lá.
    expect(resultados.slice(0, 5).map((r) => r.error)).toEqual(
      Array(5).fill("invalid_credentials"),
    );
    expect(resultados[5]?.error).toBe("rate_limited");
    expect(signIn).toHaveBeenCalledTimes(5);
  });

  it("acertar a senha não gasta o orçamento de bloqueio da conta", async () => {
    const { signInWithPassword } = await import("./signInWithPassword");
    const input = { email: "certo@example.com", password: "senha-certa-123" };

    // Provedor aceita, e a conta tem MFA — o retorno é mfa_required, o que
    // basta: o ponto é que o caminho de SUCESSO não incrementa o contador.
    signIn.mockResolvedValue({
      data: { user: { id: "u1" }, session: {} },
      error: null,
    } as never);

    const resultados = [];
    for (let i = 0; i < 10; i++) {
      resultados.push(await signInWithPassword(input));
    }

    // Nenhuma das dez foi barrada: se o sucesso contasse, a 6ª seria.
    expect(resultados.filter((r) => r?.error === "rate_limited")).toHaveLength(0);
    expect(signIn).toHaveBeenCalledTimes(10);
  });
});

describe("signInWithPassword: senha é reserva para quem está ligado ao EvaLink", () => {
  const signOut = vi.fn(async () => ({ error: null }));
  const admin = { marker: "admin-client" };

  beforeEach(() => {
    vi.resetModules();
    signOut.mockClear();
    vi.mocked(createAdminClient).mockClear();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    vi.mocked(reservaBloqueia).mockClear();
    vi.mocked(audit).mockClear();
    vi.mocked(registrarFalhaDeLogin).mockClear();
    vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: { id: "u1" }, session: {} },
          error: null,
        })),
        signOut,
        mfa: { listFactors: vi.fn(async () => ({ data: { totp: [] } })) },
      },
    } as never);
  });

  it("EvaLink ligado e a regra bloqueia: recusa, encerra só a sessão local, conta a falha e audita", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    vi.mocked(reservaBloqueia).mockResolvedValue(true);
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "ligado@example.com", password: "senha-teste-123" });

    expect(res.error).toBe("invalid_credentials");
    expect(reservaBloqueia).toHaveBeenCalledWith(admin, "u1");
    // scope "local": só esta sessão cai, não todas as sessões da pessoa
    // (incluindo as legítimas via EvaLink).
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(registrarFalhaDeLogin).toHaveBeenCalledWith("ligado@example.com", expect.anything());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.login_failed",
        metadata: expect.objectContaining({ reason: "evalink_reserva" }),
      }),
    );
  });

  it("EvaLink ligado e a regra não bloqueia: entra sem encerrar sessão nem contar falha", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    vi.mocked(reservaBloqueia).mockResolvedValue(false);
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "admin@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
    expect(registrarFalhaDeLogin).not.toHaveBeenCalled();
  });

  it("EvaLink desligado: entra sem consultar a regra nem o admin client", async () => {
    vi.mocked(configEvalink).mockReturnValue(null);
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "sem-evalink@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(reservaBloqueia).not.toHaveBeenCalled();
  });
});
