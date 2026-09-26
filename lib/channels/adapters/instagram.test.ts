import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveInstagramToken` (interno ao adapter) consulta `channel_sessions` via
 * `createAdminClient()` e decifra com `decryptWebhookSecret` — os dois mocks
 * abaixo bastam para os dois métodos novos chegarem ao `fetch` com um token.
 */
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.is = () => chain;
  chain.maybeSingle = async () => ({ data: { ig_token_encrypted: "\\xCIFRADO" }, error: null });
  return { createAdminClient: () => ({ from: () => ({ select: () => chain }) }) };
});
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: async () => "TOKEN-EM-CLARO",
}));

const { instagramAdapter } = await import("./instagram");

describe("instagramAdapter — respostas a comentário", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resposta privada endereça pelo comment_id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ message_id: "mid-1" }) } as unknown as Response);
    await instagramAdapter.respostaPrivadaAoComentario!({ organizationId: "org", sessionRef: "IG-1", commentId: "C-1", texto: "oi" });
    const [url, init] = (globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain("/IG-1/messages");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      recipient: { comment_id: "C-1" }, message: { text: "oi" },
    });
  });

  it("resposta pública vai no endpoint de replies do comentário", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ id: "reply-1" }) } as unknown as Response);
    const r = await instagramAdapter.responderComentario!({ organizationId: "org", sessionRef: "IG-1", commentId: "C-1", texto: "te mandei 💚" });
    expect(r.replyId).toBe("reply-1");
    expect(String((globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("/C-1/replies");
  });

  it("respostasAnterioresDoDono só coleta replies cujo from.id é a própria conta", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            comments: {
              data: [
                {
                  replies: {
                    data: [
                      { text: "Que bom que gostou! 🌿", from: { id: "IG-1" } },
                      { text: "eu tb amei", from: { id: "IGSID-comentarista" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    } as unknown as Response);
    const frases = await instagramAdapter.respostasAnterioresDoDono!({ organizationId: "org", sessionRef: "IG-1" });
    expect(frases).toEqual(["Que bom que gostou! 🌿"]);
  });

  it("respostasAnterioresDoDono degrada para lista vazia (nunca lança) quando a Graph recusa", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: false, status: 500, json: async () => ({ error: { message: "fora do ar" } }) } as unknown as Response);
    await expect(
      instagramAdapter.respostasAnterioresDoDono!({ organizationId: "org", sessionRef: "IG-1" }),
    ).resolves.toEqual([]);
  });
});
