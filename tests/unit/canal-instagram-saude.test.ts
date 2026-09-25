/**
 * `checkHealth` do Instagram — sonda REAL, não o `reachable:false` fixo que a
 * primeira versão do adapter devolvia.
 *
 * ─── O defeito que este teste fecha ────────────────────────────────────────
 *
 * `reachable:false` incondicional (nunca sondando de verdade) mantém a
 * sessão eternamente "não sei" na Central — um aviso que nunca resolve, para
 * toda sessão do Instagram conectada, para sempre. O conserto é medir de
 * verdade: ler `ig_token_encrypted` da sessão (organização + `ig_account_id`
 * ativa), decifrar e perguntar à Graph API `/me`.
 *
 * O token NUNCA aparece em `detail` nem em log — os casos abaixo incluem uma
 * string-armadilha no erro de rede para provar que ela não vaza no retorno.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeSingle = vi.fn();
function chain() {
  const obj = {
    select: () => obj,
    eq: () => obj,
    is: () => obj,
    maybeSingle,
  };
  return obj;
}
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => chain() }),
}));

const decryptMock = vi.fn(async () => "token-em-claro");
vi.mock("@/lib/webhooks/secrets", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptWebhookSecret: (...a: unknown[]) => decryptMock(...(a as [])),
}));

function respondeCom(status: number) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
  })) as unknown as typeof fetch;
}

const fetchOriginal = globalThis.fetch;

beforeEach(() => {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValue({ data: { ig_token_encrypted: "\\xdeadbeef" }, error: null });
  decryptMock.mockClear();
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

describe("checkHealth do Instagram", () => {
  async function saude() {
    const { instagramAdapter } = await import("@/lib/channels/adapters/instagram");
    return instagramAdapter.checkHealth!({ organizationId: "org", sessionRef: "178414" });
  }

  it("Graph responde 200 → de pé, com o status cru", async () => {
    globalThis.fetch = respondeCom(200);
    expect(await saude()).toEqual({ reachable: true, status: "200", detail: null });
  });

  it("chave revogada (401) → não alcançável, motivo em português", async () => {
    globalThis.fetch = respondeCom(401);
    expect(await saude()).toEqual({
      reachable: false,
      status: "401",
      detail: "chave do Instagram vencida ou revogada",
    });
  });

  it("erro de rede → não alcançável, sem status, e o token não vaza no detail", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET com segredo-que-nao-pode-vazar no meio");
    }) as unknown as typeof fetch;
    const r = await saude();
    expect(r).toEqual({ reachable: false, status: null, detail: "Instagram não respondeu" });
    expect(JSON.stringify(r)).not.toContain("segredo-que-nao-pode-vazar");
  });

  it("sem credencial na sessão → não alcançável, sem chamar a Graph", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await saude();
    expect(r.reachable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
