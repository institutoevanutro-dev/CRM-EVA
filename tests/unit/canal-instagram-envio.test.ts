import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { ig_token_encrypted: "cifrado" }, error: null }) }) }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

import { instagramAdapter } from "@/lib/channels/adapters/instagram";

const base = { organizationId: "org-1", sessionRef: "17841400000000001", to: "IGSID-1" };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ recipient_id: "IGSID-1", message_id: "mid.1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const corpo = () => JSON.parse(fetchMock.mock.calls[0]![1].body as string);

describe("instagramAdapter.send", () => {
  it("texto dentro de 24h sai sem tag e devolve o message_id", async () => {
    const r = await instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never);
    expect(r).toEqual({ externalId: "mid.1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/17841400000000001\/messages$/);
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(corpo()).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "Oi" } });
  });
  it("com etiqueta humana manda HUMAN_AGENT", async () => {
    await instagramAdapter.send({ ...base, kind: "text", body: "Oi", etiquetaHumana: true } as never);
    expect(corpo()).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "Oi" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });
  it("foto vai como attachment image", async () => {
    await instagramAdapter.send({ ...base, kind: "image", media: { url: "https://x/y.jpg", mime: "image/jpeg" } } as never);
    expect(corpo().message).toEqual({ attachment: { type: "image", payload: { url: "https://x/y.jpg" } } });
  });
  it("áudio é recusado sem chamar a Meta", async () => {
    await expect(instagramAdapter.send({ ...base, kind: "audio", media: { url: "https://x/a.ogg", mime: "audio/ogg" } } as never))
      .rejects.toThrow(/^instagram_tipo_nao_suportado: Por enquanto o Instagram aceita só texto e foto pelo CRM\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("texto acima de 1000 caracteres é recusado sem chamar a Meta", async () => {
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "a".repeat(1001) } as never)).rejects.toThrow(/^instagram_texto_longo:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("551 vira a frase de pessoa indisponível", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 551, message: "x" } }), { status: 400 }));
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never))
      .rejects.toThrow("instagram_551: Essa pessoa não pode receber mensagens deste perfil.");
  });
  it("190 pede reconexão", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190, message: "x" } }), { status: 401 }));
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never)).rejects.toThrow(/^instagram_190: .*Conexões/);
  });
  it("resolveRecipient usa o id da conversa", () => {
    expect(instagramAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null, providerConversationId: "IGSID-9" })).toBe("IGSID-9");
    expect(instagramAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "5527", waIdentity: null })).toBeNull();
  });
});

describe("teto de espera nas chamadas à Graph", () => {
  // Sem teto, uma Graph pendurada segura o envio (e o operador vê o relógio
  // girando) ou a ingestão do webhook inteira, não só o perfil.
  it("o envio leva AbortSignal", async () => {
    await instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never);
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("a busca de perfil leva AbortSignal e, no estouro, segue best-effort (três null)", async () => {
    const { perfilDoRemetente } = await import("@/lib/channels/instagram/graph");
    fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    const perfil = await perfilDoRemetente("TOKEN", "IGSID-1");
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(perfil).toEqual({ nome: null, handle: null, foto: null });
  });
});
