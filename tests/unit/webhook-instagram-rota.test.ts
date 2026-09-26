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
const ingerirComentarioMock = vi.fn(async () => ({ status: "gravado", id: "IC1" }));
vi.mock("@/lib/channels/instagram/comentarios/ingest", () => ({ ingerirComentario: ingerirComentarioMock }));

const { GET, POST } = await import("@/app/api/v1/webhooks/instagram/route");
const corpo = JSON.stringify({ object: "instagram", entry: [{ id: "IGACC", time: 1, messaging: [{ sender: { id: "P" }, recipient: { id: "IGACC" }, timestamp: 1, message: { mid: "m1", text: "Oi" } }] }] });
const corpoComDoisEventos = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "IGACC",
      time: 1,
      messaging: [
        { sender: { id: "P1" }, recipient: { id: "IGACC" }, timestamp: 1, message: { mid: "m1", text: "Primeiro" } },
        { sender: { id: "P2" }, recipient: { id: "IGACC" }, timestamp: 2, message: { mid: "m2", text: "Segundo" } },
      ],
    },
  ],
});
const corpoComentario = JSON.stringify({
  object: "instagram",
  entry: [{ id: "IGACC", time: 1, changes: [{ field: "comments", value: { id: "COMENTARIO-1", text: "Oi", media: { id: "MEDIA-9" }, from: { id: "IGSID9", username: "cliente" } } }] }],
});
const corpoComDoisComentarios = JSON.stringify({
  object: "instagram",
  entry: [{
    id: "IGACC",
    time: 1,
    changes: [
      { field: "comments", value: { id: "COMENTARIO-1", text: "Primeiro", media: { id: "MEDIA-9" }, from: { id: "IGSID1", username: "c1" } } },
      { field: "comments", value: { id: "COMENTARIO-2", text: "Segundo", media: { id: "MEDIA-9" }, from: { id: "IGSID2", username: "c2" } } },
    ],
  }],
});
const assinar = (s: string) => `sha256=${createHmac("sha256", "SEG").update(s).digest("hex")}`;
const post = (s: string, sig: string | null) => new NextRequest("http://x/api/v1/webhooks/instagram", { method: "POST", body: s, headers: sig ? { "x-hub-signature-256": sig } : {} });
const sessaoOk = { id: "S", organizationId: "ORG", igAccountId: "IGACC", tokenCifrado: null, origemPadrao: null };

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
    sessao.mockResolvedValue({ status: "ausente" });
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });
  it("conta conectada: ingere com a sessão resolvida", async () => {
    sessao.mockResolvedValue({ status: "ok", sessao: sessaoOk });
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).toHaveBeenCalledTimes(1);
  });
  it("exceção na ingestão do primeiro evento não aborta o segundo, e a resposta é 500", async () => {
    sessao.mockResolvedValue({ status: "ok", sessao: sessaoOk });
    ingerir
      .mockRejectedValueOnce(new Error("graph api caiu"))
      .mockResolvedValueOnce({ status: "ingerida", messageId: "M2", conversationId: "C2", contatoNovo: false });
    const r = await POST(post(corpoComDoisEventos, assinar(corpoComDoisEventos)));
    expect(ingerir).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
    expect(r.status).toBe(500);
  });
  it("falha na consulta da sessão: logger.error e 500", async () => {
    sessao.mockResolvedValue({ status: "erro", motivo: "conexão recusada" });
    const r = await POST(post(corpo, assinar(corpo)));
    expect(ingerir).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(r.status).toBe(500);
  });

  describe("laço de comentários", () => {
    it("conta não conectada: 200, nada gravado, log", async () => {
      sessao.mockResolvedValue({ status: "ausente" });
      const r = await POST(post(corpoComentario, assinar(corpoComentario)));
      expect(r.status).toBe(200);
      expect(ingerirComentarioMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalled();
    });

    it("falha na consulta da sessão: logger.error e 500", async () => {
      sessao.mockResolvedValue({ status: "erro", motivo: "conexão recusada" });
      const r = await POST(post(corpoComentario, assinar(corpoComentario)));
      expect(ingerirComentarioMock).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
      expect(r.status).toBe(500);
    });

    it("conta conectada: grava com a sessão resolvida", async () => {
      sessao.mockResolvedValue({ status: "ok", sessao: sessaoOk });
      const r = await POST(post(corpoComentario, assinar(corpoComentario)));
      expect(r.status).toBe(200);
      expect(ingerirComentarioMock).toHaveBeenCalledTimes(1);
    });

    it("exceção no primeiro comentário não aborta o segundo, e a resposta é 500", async () => {
      sessao.mockResolvedValue({ status: "ok", sessao: sessaoOk });
      ingerirComentarioMock
        .mockRejectedValueOnce(new Error("banco caiu"))
        .mockResolvedValueOnce({ status: "gravado", id: "IC2" });
      const r = await POST(post(corpoComDoisComentarios, assinar(corpoComDoisComentarios)));
      expect(ingerirComentarioMock).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalled();
      expect(r.status).toBe(500);
    });

    it("erro de insert que não é 23505 (falhou_infra) faz a rota responder 500", async () => {
      sessao.mockResolvedValue({ status: "ok", sessao: sessaoOk });
      ingerirComentarioMock.mockResolvedValueOnce({ status: "falhou_infra", motivo: "connection failure" } as never);
      const r = await POST(post(corpoComentario, assinar(corpoComentario)));
      expect(ingerirComentarioMock).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
      expect(r.status).toBe(500);
    });
  });
});
