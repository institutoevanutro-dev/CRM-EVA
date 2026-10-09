/**
 * POST /api/v1/messages: o erro 422 do handler (media_not_ready) chega ao
 * cliente REST com `details.situacao`, não só com a mensagem.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    supabase: {},
    organizationId: "org",
    actor: { type: "user", id: "u" },
    idioma: "pt-BR",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("./_handler", () => ({
  sendMessageHandler: vi.fn(async () => {
    throw new ApiError(422, "media_not_ready", { situacao: "sem_termo" }, "req", "Esta mídia não pode ser enviada agora.");
  }),
}));

import { POST } from "./route";

describe("POST /messages", () => {
  it("422 media_not_ready carrega details.situacao", async () => {
    const res = await POST(
      new NextRequest("http://x/api/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: "11111111-1111-4111-8111-111111111111",
          type: "text",
          media_library_item_id: "44444444-4444-4444-8444-444444444444",
        }),
      }),
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; details?: { situacao?: string } } };
    expect(json.error.code).toBe("media_not_ready");
    expect(json.error.details?.situacao).toBe("sem_termo");
  });
});
