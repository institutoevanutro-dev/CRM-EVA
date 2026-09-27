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

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/evalink/config", () => ({ configEvalink: vi.fn() }));
vi.mock("@/lib/audit", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  audit: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

/** Dublê chainable: qualquer método intermediário devolve a si mesmo; o `await` no fim resolve `resultado`. */
function chainable(resultado: unknown) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    is: () => obj,
    limit: () => obj,
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return obj;
}

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

describe("signInWithPassword — senha é reserva para quem está ligado ao EvaLink", () => {
  const signOut = vi.fn(async () => ({ error: null }));

  beforeEach(() => {
    vi.resetModules();
    signOut.mockClear();
    vi.mocked(createAdminClient).mockClear();
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

  function mockAdmin(opts: { ligado: boolean; orgAdmin?: boolean; platformAdmin?: boolean }) {
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => {
        if (table === "evalink_vinculos") {
          return chainable({ data: opts.ligado ? { user_id: "u1" } : null, error: null });
        }
        if (table === "user_organizations") {
          return chainable({ data: opts.orgAdmin ? [{ id: "o1" }] : [], error: null });
        }
        if (table === "platform_admins") {
          return chainable({ data: opts.platformAdmin ? { user_id: "u1" } : null, error: null });
        }
        throw new Error(`tabela inesperada: ${table}`);
      },
    } as never);
  }

  it("EvaLink ligado, vinculado e sem admin ativo: recusa, encerra a sessão e conta a falha", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    mockAdmin({ ligado: true, orgAdmin: false, platformAdmin: false });
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "ligado@example.com", password: "senha-teste-123" });

    expect(res.error).toBe("invalid_credentials");
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("EvaLink ligado e vinculado, mas admin de org ativo: entra", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    mockAdmin({ ligado: true, orgAdmin: true, platformAdmin: false });
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "admin-org@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("EvaLink ligado e vinculado, mas platform admin ativo: entra", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    mockAdmin({ ligado: true, orgAdmin: false, platformAdmin: true });
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "admin-plataforma@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("EvaLink ligado, mas usuário não vinculado: entra sem restrição", async () => {
    vi.mocked(configEvalink).mockReturnValue({} as never);
    mockAdmin({ ligado: false });
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "nao-ligado@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("EvaLink desligado: entra sem consulta extra ao admin client", async () => {
    vi.mocked(configEvalink).mockReturnValue(null);
    const { signInWithPassword } = await import("./signInWithPassword");

    const res = await signInWithPassword({ email: "sem-evalink@example.com", password: "senha-teste-123" });

    expect(res).toBeUndefined();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
