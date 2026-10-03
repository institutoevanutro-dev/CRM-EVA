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
const loggerWarnMock = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => loggerWarnMock(...a), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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

  // ─── I-5: "sem histórico" (estado normal) e "a Graph recusou" (config/rede) ─
  // são coisas DIFERENTES — a primeira versão devolvia `[]` para as duas sem
  // logar nada, e quem lê o log não tinha como saber qual das duas aconteceu.
  it("respostasAnterioresDoDono LOGA quando a Graph recusa (I-5, distinção)", async () => {
    loggerWarnMock.mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: false, status: 429, json: async () => ({ error: { message: "rate limit" } }) } as unknown as Response);
    await instagramAdapter.respostasAnterioresDoDono!({ organizationId: "org", sessionRef: "IG-1" });
    expect(loggerWarnMock).toHaveBeenCalled();
    const [, meta] = loggerWarnMock.mock.calls[0]!;
    expect((meta as Record<string, unknown>).status).toBe(429);
  });

  it("respostasAnterioresDoDono NÃO loga quando a Graph responde OK e não há histórico ainda (I-5, distinção)", async () => {
    loggerWarnMock.mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response);
    const frases = await instagramAdapter.respostasAnterioresDoDono!({ organizationId: "org", sessionRef: "IG-1" });
    expect(frases).toEqual([]);
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it("listarPublicacoes devolve capa do vídeo, imagem como capa e ignora item sem id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "M-1", caption: "Comente CARDAPIO", media_type: "VIDEO", media_url: "https://x/v.mp4", thumbnail_url: "https://x/capa.jpg", permalink: "https://ig/p/1", timestamp: "2026-10-01T10:00:00+0000" },
          { id: "M-2", media_type: "IMAGE", media_url: "https://x/foto.jpg" },
          { caption: "sem id" },
        ],
      }),
    } as unknown as Response);
    const lista = await instagramAdapter.listarPublicacoes!({ organizationId: "org", sessionRef: "IG-1" });
    expect(String((globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain("/IG-1/media?fields=");
    expect(lista).toEqual([
      { id: "M-1", legenda: "Comente CARDAPIO", tipo: "VIDEO", miniatura: "https://x/capa.jpg", link: "https://ig/p/1", publicadaEm: "2026-10-01T10:00:00+0000" },
      { id: "M-2", legenda: null, tipo: "IMAGE", miniatura: "https://x/foto.jpg", link: null, publicadaEm: null },
    ]);
  });

  it("listarPublicacoes devolve null (não lista vazia) quando a Graph recusa ou a rede cai", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      { ok: false, status: 400, json: async () => ({ error: { message: "sem permissão" } }) } as unknown as Response);
    await expect(instagramAdapter.listarPublicacoes!({ organizationId: "org", sessionRef: "IG-1" })).resolves.toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
    await expect(instagramAdapter.listarPublicacoes!({ organizationId: "org", sessionRef: "IG-1" })).resolves.toBeNull();
  });
});
