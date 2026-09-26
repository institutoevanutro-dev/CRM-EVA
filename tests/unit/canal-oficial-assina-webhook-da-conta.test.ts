import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONECTAR O CANAL OFICIAL TAMBÉM DIZ À META PARA ONDE ENTREGAR.
 *
 * O app da Meta tem um callback só. A segunda conta, noutra organização, nunca
 * recebia mensagem: a Meta entregava na URL da primeira sessão, que ignora a
 * WABA alheia (medido em produção em 26/09/2026). Agora o POST assina a WABA com
 * a URL da PRÓPRIA sessão, e se a Meta recusar a conexão continua gravada e a
 * tela é avisada.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const PATH_TOKEN = "tok-da-sessao-nova";

const assinar = vi.fn();
const filtrosDaReleitura: Array<[string, unknown]> = [];

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR", is_platform_admin: false },
    org: { orgId: ORG, role: "admin" },
  }),
}));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: async () => ({
    ok: true,
    displayPhoneNumber: "+55 11 99999-8888",
    verifiedName: "Clínica",
    qualityRating: null,
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "\\x_cifra" }));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: "s", verifyToken: "verify-da-instalacao" }),
  appDaMetaDoAmbiente: () => ({ appSecret: null, verifyToken: null }),
}));
vi.mock("@/lib/channels/meta/assinar-webhook", () => ({
  assinarWebhookDaConta: (...a: unknown[]) => assinar(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      let colunas = "";
      const q = {
        select: (c: string) => ((colunas = c), q),
        eq: (k: string, v: unknown) => {
          if (colunas === "webhook_path_token") filtrosDaReleitura.push([k, v]);
          return q;
        },
        is: () => q,
        maybeSingle: async () =>
          colunas === "webhook_path_token"
            ? { data: { webhook_path_token: PATH_TOKEN }, error: null }
            : { data: null, error: null },
        insert: async () => ({ error: null }),
      };
      return q;
    },
  }),
}));

async function conectar(): Promise<{ status: number; data: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/v1/channels/official/route");
  const res = await POST(
    new NextRequest("http://localhost/api/v1/channels/official", {
      method: "POST",
      body: JSON.stringify({ phone_number_id: "1103328999528818", waba_id: "2434045433735175", token: "EAAG".padEnd(30, "x") }),
    }),
  );
  return { status: res.status, data: ((await res.json()) as { data: Record<string, unknown> }).data };
}

beforeEach(() => {
  assinar.mockReset();
  filtrosDaReleitura.length = 0;
});

describe("POST /api/v1/channels/official — assina o webhook da conta", () => {
  it("chama a Meta com a URL da própria sessão, lida filtrando a organização", async () => {
    assinar.mockResolvedValue({ ok: true });

    const r = await conectar();

    expect(r.status).toBe(200);
    expect(r.data.webhook).toEqual({ assinado: true });
    expect(assinar).toHaveBeenCalledWith({
      wabaId: "2434045433735175",
      token: "EAAG".padEnd(30, "x"),
      // A base vem de NEXT_PUBLIC_APP_URL quando configurada (o .env.local pode tê-la).
      callbackUrl: expect.stringMatching(new RegExp(`^https?://[^/]+/api/v1/webhooks/meta/${PATH_TOKEN}$`)),
      verifyToken: "verify-da-instalacao",
    });
    expect(filtrosDaReleitura).toContainEqual(["organization_id", ORG]);
  });

  it("Meta recusou: a conexão fica, e a resposta diz que o webhook não foi assinado", async () => {
    assinar.mockResolvedValue({ ok: false, motivo: "Callback verification failed" });

    const r = await conectar();

    expect(r.status).toBe(200);
    expect(r.data.connected).toBe(true);
    expect(r.data.webhook).toEqual({ assinado: false, motivo: "Callback verification failed" });
  });
});
