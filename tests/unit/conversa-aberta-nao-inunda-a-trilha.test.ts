/**
 * A CONVERSA ABERTA NÃO INUNDA A TRILHA.
 *
 * A auditoria de leitura (A8) grava quem abriu as mensagens de um paciente. Mas o
 * inbox recarrega a primeira página a cada mensagem que chega pelo Realtime, a
 * cada volta de foco da aba e pela rede de segurança — e cada recarga virava uma
 * linha. É a mesma classe do ruído de cron que já foi 95% do `api_audit_log`.
 *
 * A regra é sem estado: audita a primeira página; recarga do que já está na tela
 * vem marcada pelo cliente (`atualizacao=1`) e paginação traz `cursor`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auditSpy = vi.fn(async (_e: unknown) => {});
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) } }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "o1", role: "agent" }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  listMessagesHandler: async () => ({ messages: [{ id: "m1" }], cursor: null, has_more: false }),
}));

import { GET } from "@/app/api/v1/conversations/[id]/messages/route";

const CONV = "44444444-4444-4444-8444-444444444444";
const chamar = (qs: string) =>
  GET(new NextRequest(`http://x/api/v1/conversations/${CONV}/messages${qs}`), {
    params: Promise.resolve({ id: CONV }),
  });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GET conversations/[id]/messages — auditoria de leitura", () => {
  beforeEach(() => auditSpy.mockClear());

  it("abrir a conversa audita (1 linha)", async () => {
    expect((await chamar("?limit=50")).status).toBe(200);
    await tick();
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({ action: "conversation.viewed", resourceId: CONV });
  });

  it("recarga disparada pelo Realtime (dado já na tela) NÃO audita", async () => {
    for (let i = 0; i < 5; i++) expect((await chamar("?limit=50&atualizacao=1")).status).toBe(200);
    await tick();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("rolar para mensagens antigas (cursor) NÃO audita", async () => {
    expect((await chamar("?cursor=abc&limit=50")).status).toBe(200);
    await tick();
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
