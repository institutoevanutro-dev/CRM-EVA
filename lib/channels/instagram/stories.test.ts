import { describe, expect, it, vi } from "vitest";

import { storiesRecentes } from "./stories";

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

describe("stories da conta", () => {
  it("lê id e hora; manda o token no cabeçalho, nunca na URL", async () => {
    const buscar = vi.fn().mockResolvedValue(resposta(200, { data: [{ id: "s1", timestamp: "2026-11-03T14:00:00+0000" }, { id: 7 }] }));
    const r = await storiesRecentes("tok-123", "999", buscar as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, stories: [{ id: "s1", timestamp: "2026-11-03T14:00:00+0000" }] });
    const [url, init] = buscar.mock.calls[0]!;
    expect(String(url)).toContain("/999/stories?fields=id,timestamp");
    expect(String(url)).not.toContain("tok-123");
    expect((init as RequestInit).headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("400 ou 403 é falta de permissão (cai no lançamento manual)", async () => {
    for (const status of [400, 403]) {
      const buscar = vi.fn().mockResolvedValue(resposta(status, { error: { code: 10 } }));
      expect(await storiesRecentes("t", "1", buscar as unknown as typeof fetch)).toEqual({ ok: false, motivo: "sem_permissao" });
    }
  });

  it("rede caída é falha, não exceção", async () => {
    const buscar = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await storiesRecentes("t", "1", buscar as unknown as typeof fetch)).toEqual({ ok: false, motivo: "falha" });
  });
});
