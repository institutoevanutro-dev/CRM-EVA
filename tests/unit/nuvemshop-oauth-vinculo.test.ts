/**
 * M6 — a volta do OAuth da Nuvemshop precisa provar três coisas antes de gravar
 * o token na organização do `state`:
 *
 *  1. quem voltou é o navegador que saiu (cookie Lax de vínculo, o mesmo
 *     mecanismo de `agenda/google/callback`);
 *  2. o `state` vale UMA vez (nonce queimado em `calendar_oauth_nonces`);
 *  3. quem pediu AINDA é admin da organização — o papel pode ter caído nos dez
 *     minutos do consentimento.
 *
 * Vermelho sem o fix: o callback só conferia a assinatura, e um `state` vazado
 * (histórico, log do parceiro) gravava a loja de quem o reapresentasse.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  audit: vi.fn(),
  papel: "admin" as string | null,
  platformAdmin: false,
  nonces: new Set<string>(),
  upserts: 0,
}));

vi.mock("@/lib/audit", () => ({ audit: fake.audit }));
vi.mock("@/lib/impersonate/support", () => ({
  supportCallbackWriteAllowed: async () => true,
  supportWriteError: () => null,
  authenticatedSessionId: async () => "33333333-3333-4333-8333-333333333333",
}));
const cookiesGravados = vi.hoisted(() => [] as Array<{ name: string; value: string; opts: Record<string, unknown> }>);
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, opts: Record<string, unknown>) => cookiesGravados.push({ name, value, opts }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u", is_platform_admin: false, support: null }),
  resolveActiveOrg: async () => ({ orgId: "o", role: "admin" }),
}));
vi.mock("@/lib/nuvemshop/config", () => ({
  getConfig: () => ({ clientSecret: "local", appId: "1" }),
  SUBSCRIBED_EVENTS: [],
  eventToSlug: () => "x",
}));
vi.mock("@/lib/nuvemshop/oauth", () => ({
  exchangeCodeForToken: async () => ({ ok: true, accessToken: "tok", storeId: "1", scope: "" }),
  buildAuthorizeUrl: ({ state }: { state: string }) =>
    `https://parceiro.exemplo/authorize?state=${encodeURIComponent(state)}`,
}));
vi.mock("@/lib/nuvemshop/api-client", () => ({ NuvemshopApiClient: class {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: "\\x00", error: null }),
    from: (tabela: string) => {
      const b: Record<string, unknown> = {};
      const self = () => b;
      Object.assign(b, {
        select: self,
        eq: self,
        is: self,
        maybeSingle: async () => {
          if (tabela === "user_organizations") {
            return { data: fake.papel ? { role: fake.papel } : null, error: null };
          }
          if (tabela === "platform_admins") {
            return { data: fake.platformAdmin ? { user_id: "x" } : null, error: null };
          }
          return { data: null, error: null };
        },
        insert: async (linha: { nonce: string }) => {
          if (fake.nonces.has(linha.nonce)) return { error: { code: "23505", message: "dup" } };
          fake.nonces.add(linha.nonce);
          return { error: null };
        },
        upsert: () => {
          fake.upserts++;
          return { select: () => ({ single: async () => ({ data: { id: "i" }, error: null }) }) };
        },
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      });
      return b;
    },
  }),
}));

import { issueState, vinculoDoState, NOME_DO_VINCULO_NUVEMSHOP } from "@/lib/nuvemshop/state";
import { GET } from "@/app/api/v1/integrations/nuvemshop/callback/route";
import { connectNuvemshop } from "@/app/actions/integrations/connectNuvemshop";

const ORG = randomUUID();
const USER = randomUUID();

function volta(state: string, cookie: string | null): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/v1/integrations/nuvemshop/callback?code=c&state=${encodeURIComponent(state)}`,
  );
  if (cookie !== null) req.cookies.set(NOME_DO_VINCULO_NUVEMSHOP, cookie);
  return req;
}

function destino(res: Response): string {
  return new URL(res.headers.get("location") ?? "").search;
}

beforeEach(() => {
  fake.papel = "admin";
  fake.platformAdmin = false;
  fake.upserts = 0;
  fake.audit.mockReset();
});

describe("callback da Nuvemshop", () => {
  it("volta com o vínculo do mesmo navegador grava e limpa o cookie", async () => {
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    const res = await GET(volta(state, vinculoDoState(nonce)));
    expect(destino(res)).toBe("?ok=1");
    expect(fake.upserts).toBe(1);
    expect(res.headers.get("set-cookie")).toContain(`${NOME_DO_VINCULO_NUVEMSHOP}=;`);
  });

  it("sem o cookie de vínculo recusa, mesmo com state assinado", async () => {
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    const res = await GET(volta(state, null));
    expect(destino(res)).toBe("?error=invalid_state");
    expect(fake.upserts).toBe(0);
  });

  it("cookie de OUTRO fluxo não serve", async () => {
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    const res = await GET(volta(state, vinculoDoState(randomUUID())));
    expect(destino(res)).toBe("?error=invalid_state");
    expect(fake.upserts).toBe(0);
  });

  it("o mesmo state vale uma vez só", async () => {
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    await GET(volta(state, vinculoDoState(nonce)));
    const segunda = await GET(volta(state, vinculoDoState(nonce)));
    expect(destino(segunda)).toBe("?error=invalid_state");
    expect(fake.upserts).toBe(1);
  });

  it("quem deixou de ser admin no meio do consentimento é recusado", async () => {
    fake.papel = "agent";
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    const res = await GET(volta(state, vinculoDoState(nonce)));
    expect(destino(res)).toBe("?error=forbidden");
    expect(fake.upserts).toBe(0);
  });

  it("super-admin da plataforma segue podendo conectar", async () => {
    fake.papel = null;
    fake.platformAdmin = true;
    const nonce = randomUUID();
    const state = issueState(ORG, { userId: USER, authSessionId: randomUUID() }, nonce);
    const res = await GET(volta(state, vinculoDoState(nonce)));
    expect(destino(res)).toBe("?ok=1");
  });

  it("state sem ator (formato antigo) é recusado", async () => {
    const nonce = randomUUID();
    const state = issueState(ORG, undefined, nonce);
    const res = await GET(volta(state, vinculoDoState(nonce)));
    expect(destino(res)).toBe("?error=invalid_state");
    expect(fake.upserts).toBe(0);
  });
});

describe("ida (connectNuvemshop)", () => {
  it("planta o cookie Lax de vínculo, restrito ao caminho do callback, casando com o state", async () => {
    cookiesGravados.length = 0;
    const erro = await connectNuvemshop().catch((e: Error) => e.message);
    expect(String(erro)).toMatch(/^REDIRECT /);
    const url = new URL(String(erro).slice("REDIRECT ".length));
    const state = url.searchParams.get("state") ?? "";
    const [c] = cookiesGravados;
    expect(c?.name).toBe(NOME_DO_VINCULO_NUVEMSHOP);
    expect(c?.opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/v1/integrations/nuvemshop/callback" });
    const res = await GET(volta(state, c!.value));
    expect(destino(res)).toBe("?ok=1");
  });
});
