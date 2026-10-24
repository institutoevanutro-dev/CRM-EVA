/**
 * POST /api/v1/messages: o erro 422 do handler (media_not_ready) chega ao
 * cliente REST com `details.situacao`, não só com a mensagem; e o ritmo da fila
 * de leads antigos barra só o envio de PESSOA, antes do handler.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { ritmoDaFila } from "@/lib/bonus/ritmo";

import { sendMessageHandler } from "./_handler";

const autenticado = (actor: { type: string; id: string }, idioma = "pt-BR") => ({
  ok: true,
  supabase: {},
  organizationId: "org",
  actor,
  idioma,
});

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/bonus/ritmo", () => ({ ritmoDaFila: vi.fn(async () => ({ tipo: "pode" })) }));
vi.mock("./_handler", () => ({ sendMessageHandler: vi.fn() }));

import { POST } from "./route";

const CONV = "11111111-1111-4111-8111-111111111111";
const enviar = (corpo: Record<string, unknown> = { conversation_id: CONV, type: "text", body: "oi" }) =>
  POST(new NextRequest("http://x/api/v1/messages", { method: "POST", body: JSON.stringify(corpo) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthDual).mockResolvedValue(autenticado({ type: "user", id: "u" }) as never);
  vi.mocked(ritmoDaFila).mockResolvedValue({ tipo: "pode" });
  vi.mocked(sendMessageHandler).mockResolvedValue({ id: "m1" } as never);
});

describe("POST /messages", () => {
  it("422 media_not_ready carrega details.situacao", async () => {
    vi.mocked(sendMessageHandler).mockRejectedValue(
      new ApiError(422, "media_not_ready", { situacao: "sem_termo" }, "req", "Esta mídia não pode ser enviada agora."),
    );
    const res = await enviar({ conversation_id: CONV, type: "text", media_library_item_id: "44444444-4444-4444-8444-444444444444" });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; details?: { situacao?: string } } };
    expect(json.error.code).toBe("media_not_ready");
    expect(json.error.details?.situacao).toBe("sem_termo");
  });

  it("ritmo pode: o envio de pessoa sai (201) com a organização da autenticação", async () => {
    const res = await enviar();
    expect(res.status).toBe(201);
    expect(ritmoDaFila).toHaveBeenCalledWith(expect.anything(), "org", CONV);
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });

  it("aguarde 8: 429 bonus_ritmo com Retry-After, e nada é enviado", async () => {
    vi.mocked(ritmoDaFila).mockResolvedValue({ tipo: "aguarde", segundos: 8 });
    const res = await enviar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("8");
    const json = (await res.json()) as { error: { code: string; message: string; details: { aguarde_s: number } } };
    expect(json.error.code).toBe("bonus_ritmo");
    expect(json.error.details.aguarde_s).toBe(8);
    expect(json.error.message).toBe("Aguarde 8 s para mandar a próxima mensagem da fila (proteção do número).");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("o texto do 429 sai em espanhol para quem usa es", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue(autenticado({ type: "user", id: "u" }, "es") as never);
    vi.mocked(ritmoDaFila).mockResolvedValue({ tipo: "aguarde", segundos: 8 });
    const json = (await (await enviar()).json()) as { error: { message: string } };
    expect(json.error.message).toBe("Espere 8 s para enviar el próximo mensaje de la fila (protección del número).");
  });

  it("fora da janela: 422 fora_da_janela_da_fila com as horas do número, e nada é enviado", async () => {
    vi.mocked(ritmoDaFila).mockResolvedValue({ tipo: "fora_da_janela", inicio: 8, fim: 20 });
    const res = await enviar();
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("fora_da_janela_da_fila");
    expect(json.error.message).toBe("Fora do horário de envio do número (8h às 20h). A mensagem da fila sai dentro da janela.");
    expect(sendMessageHandler).not.toHaveBeenCalled();
  });

  it("envio por token (ai_agent): o ritmo não é consultado", async () => {
    vi.mocked(resolveAuthDual).mockResolvedValue(autenticado({ type: "ai_agent", id: "tok" }) as never);
    vi.mocked(ritmoDaFila).mockResolvedValue({ tipo: "aguarde", segundos: 8 });
    const res = await enviar();
    expect(res.status).toBe(201);
    expect(ritmoDaFila).not.toHaveBeenCalled();
    expect(sendMessageHandler).toHaveBeenCalledOnce();
  });
});
