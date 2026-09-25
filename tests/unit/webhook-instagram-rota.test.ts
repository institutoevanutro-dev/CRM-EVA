import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/instagram/app", () => ({ appDoInstagram: async () => ({ appId: "1", appSecret: "SEG" }) }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: async () => ({ appSecret: "x", verifyToken: "VT" }) }));
const sessao = vi.fn();
vi.mock("@/lib/channels/instagram/sessao", () => ({ sessaoDoInstagramPorConta: sessao }));
const ingerir = vi.fn(async () => ({ status: "ingerida", messageId: "M", conversationId: "C", contatoNovo: true }));
vi.mock("@/lib/channels/instagram/ingest", () => ({ ingerirDoInstagram: ingerir }));

const { GET, POST } = await import("@/app/api/v1/webhooks/instagram/route");
const corpo = JSON.stringify({ object: "instagram", entry: [{ id: "IGACC", time: 1, messaging: [{ sender: { id: "P" }, recipient: { id: "IGACC" }, timestamp: 1, message: { mid: "m1", text: "Oi" } }] }] });
const assinar = (s: string) => `sha256=${createHmac("sha256", "SEG").update(s).digest("hex")}`;
const post = (s: string, sig: string | null) => new NextRequest("http://x/api/v1/webhooks/instagram", { method: "POST", body: s, headers: sig ? { "x-hub-signature-256": sig } : {} });

beforeEach(() => { vi.clearAllMocks(); });

describe("webhook do Instagram", () => {
  it("GET responde o desafio com o verify token da instalação", async () => {
    const r = await GET(new NextRequest("http://x/api/v1/webhooks/instagram?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("42");
  });
  it("assinatura inválida: 401 e log", async () => {
    const r = await POST(post(corpo, "sha256=00"));
    expect(r.status).toBe(401);
    expect(logger.warn).toHaveBeenCalled();
    expect(ingerir).not.toHaveBeenCalled();
  });
  it("conta não conectada: 200, nada gravado, log", async () => {
    sessao.mockResolvedValue(null);
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });
  it("conta conectada: ingere com a sessão resolvida", async () => {
    sessao.mockResolvedValue({ id: "S", organizationId: "ORG", igAccountId: "IGACC", tokenCifrado: null, origemPadrao: null });
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).toHaveBeenCalledTimes(1);
  });
});
