// @vitest-environment node
/**
 * A MARCA "NOTA DE VOZ" NO UPLOAD (porte do original #3191).
 *
 * O iPhone grava `audio/mp4` (AAC), e os canais oficiais só aceitam opus como
 * nota de voz. O gravador do composer manda `nota_de_voz=1`, e só com essa
 * marca o servidor reencoda: um m4a enviado por token, sem a marca, segue
 * intacto (uma música não pode virar opus mono de 24k). O valor é validado
 * por Zod: qualquer outro texto é 422, e não "talvez".
 *
 * Ambiente `node`: o upload passa por `FormData`/`File` do Node, e no jsdom o
 * `File` do teste e o da rota seriam de mundos diferentes (`instanceof` falha).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transcodificar = vi.hoisted(() =>
  vi.fn(async (input: { buffer: Buffer; mime: string; notaDeVoz?: boolean }) => ({
    buffer: input.buffer,
    mime: input.mime,
    convertido: false,
  })),
);

vi.mock("@/lib/messaging/media/voice-transcode", () => ({ transcodificarNotaDeVoz: transcodificar }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
    org: { orgId: "22222222-2222-4222-8222-222222222222", name: "Org", role: "agent" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { id: "33333333-3333-4333-8333-333333333333" }, error: null }),
    };
    return { from: () => chain };
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async () => ({ data: true, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  })),
}));

import { POST } from "@/app/api/v1/conversations/[id]/media/route";

const CONV = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: CONV }) };

function enviar(marca?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "ptt.m4a", { type: "audio/mp4" }));
  if (marca !== undefined) form.append("nota_de_voz", marca);
  return POST(new NextRequest(`http://localhost/api/v1/conversations/${CONV}/media`, { method: "POST", body: form }), ctx);
}

beforeEach(() => {
  transcodificar.mockClear();
});

describe("upload de mídia: a marca de nota de voz", () => {
  it("com nota_de_voz=1 o conversor recebe a marca", async () => {
    const r = await enviar("1");
    expect(r.status).toBe(200);
    expect(transcodificar).toHaveBeenCalledWith(expect.objectContaining({ mime: "audio/mp4", notaDeVoz: true }));
  });

  it("sem a marca o arquivo segue como veio (o conversor recebe notaDeVoz=false)", async () => {
    const r = await enviar();
    expect(r.status).toBe(200);
    expect(transcodificar).toHaveBeenCalledWith(expect.objectContaining({ notaDeVoz: false }));
  });

  it("valor diferente de 1 é 422, sem converter nada", async () => {
    const r = await enviar("sim");
    expect(r.status).toBe(422);
    expect(transcodificar).not.toHaveBeenCalled();
  });
});
