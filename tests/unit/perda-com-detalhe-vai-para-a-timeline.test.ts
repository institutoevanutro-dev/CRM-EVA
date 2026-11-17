/**
 * "OUTRO MOTIVO" COM DETALHE NA ROTA DE PERDA (auditoria 16/11, achado 29).
 *
 * A tela passou a mandar `lost_reason: "other"` (canônico, que o trigger aceita
 * em qualquer funil) e o texto livre em `detalhe`. Aqui se prova a outra ponta:
 * a rota grava o motivo como veio e leva o detalhe para a linha da timeline —
 * sem isso o texto digitado seria aceito pela tela e jogado fora pelo servidor.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const encerraDemanda = vi.hoisted(() => vi.fn(async () => ({ lead: { id: "lead-1" }, jaEstava: false })));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u-1", idioma: "pt-BR" }, org: { orgId: "org-1" } }),
}));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda }));

const { POST } = await import("@/app/api/v1/leads/[id]/lose/route");

function pedir(corpo: unknown) {
  return POST(
    new NextRequest("http://local/api/v1/leads/lead-1/lose", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: "lead-1" }) },
  );
}

beforeEach(() => encerraDemanda.mockClear());

describe("POST /leads/[id]/lose com detalhe", () => {
  it("grava `other` como motivo e leva o detalhe para a timeline", async () => {
    const res = await pedir({ lost_reason: "other", detalhe: " Cliente mudou de ideia " });
    expect(res.status).toBe(200);
    expect(encerraDemanda).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        motivo: "other",
        razaoNaTimeline: "Perdido — Outro motivo: Cliente mudou de ideia",
        payloadNaTimeline: { detalhe: "Cliente mudou de ideia" },
      }),
    );
  });

  it("sem detalhe, a linha da timeline é a de sempre", async () => {
    await pedir({ lost_reason: "price" });
    const entrada = (encerraDemanda.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(entrada).toEqual({ leadId: "lead-1", desfecho: "lost", motivo: "price" });
  });
});
