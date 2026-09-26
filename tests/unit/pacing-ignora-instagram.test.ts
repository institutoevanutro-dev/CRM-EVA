/**
 * O ritmo (`GET /api/v1/ai/pacing`) só existe para canais onde a IA manda
 * mensagem sozinha — o Instagram (etapa 2) é respondido pela EQUIPE, pelo
 * Inbox, sem throttle de robô. Oferecer knobs de anti-ban para uma sessão que
 * a IA nunca usa é confuso à toa, e a lista tinha que vir da MESMA regra que
 * `lib/automation/start-conversation.ts` usa para escolher canal de automação
 * (`providersDeEnvioAutomatico`) — uma segunda lista (`PROVIDERS_DE_MENSAGEM`
 * cru) divergiria no dia em que um canal novo entrasse só para RECEBER.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { providersDeEnvioAutomatico } from "@/lib/channels";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("GET /api/v1/ai/pacing — a lista de canais é a de envio automático", () => {
  it("consulta channel_sessions filtrando por providersDeEnvioAutomatico() (sem meta_instagram)", async () => {
    const providersUsados: unknown[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: (coluna: string, valores: unknown[]) => {
        if (coluna === "provider") providersUsados.push(valores);
        return chain;
      },
      order: () => Promise.resolve({ data: [], error: null }),
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
    };
    vi.mocked(createAdminClient).mockReturnValue({ from: () => chain } as never);

    const { GET } = await import("@/app/api/v1/ai/pacing/route");
    const res = await GET();
    expect(res.status).toBe(200);

    const providers = providersUsados[0] as string[];
    expect(providers).not.toContain("meta_instagram");
    expect(providers).toEqual([...providersDeEnvioAutomatico()]);
  });
});
