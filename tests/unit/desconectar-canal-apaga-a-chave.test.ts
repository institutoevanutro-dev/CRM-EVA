/**
 * Excluir um canal pela rota genérica (`DELETE /api/v1/channel-sessions/[id]`)
 * apaga a chave dele, qualquer que seja o canal.
 *
 * O defeito: a rota só zerava `meta_token_encrypted`. Uma conta do Instagram
 * arquivada por aqui guardava `ig_token_encrypted`, um token de 60 dias, numa
 * linha que a tela já não mostra: acesso vivo sem dono.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { CHANNEL_PROVIDER_INSTAGRAM } from "@/lib/channels/capabilities";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "U1", idioma: "pt-BR" },
    org: { orgId: "ORG" },
  })),
}));
vi.mock("@/lib/auth/server", () => ({
  mfaEmDivida: vi.fn(async () => false),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/waha/client", () => ({ getWahaClient: vi.fn(() => null), wahaFriendlyError: String }));

const patches: Record<string, unknown>[] = [];
const filtrosDoUpdate: [string, unknown][] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => {
        const q = {
          eq: () => q,
          maybeSingle: async () => ({
            data: {
              id: "S1",
              provider: CHANNEL_PROVIDER_INSTAGRAM,
              waha_session_name: null,
              display_name: "@clinica",
              phone_number: null,
            },
          }),
        };
        return q;
      },
      update: (patch: Record<string, unknown>) => {
        patches.push(patch);
        const q = {
          eq: (c: string, v: unknown) => (filtrosDoUpdate.push([c, v]), q),
          then: (ok: (v: unknown) => void) => ok({ error: null }),
        };
        return q;
      },
    }),
  }),
}));

// Uma conversa pendurada: o desfecho é ARQUIVAR (o caso em que a linha fica).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const q = {
          eq: () => q,
          then: (ok: (v: unknown) => void) => ok({ count: tabela === "conversations" ? 1 : 0 }),
        };
        return q;
      },
    }),
  }),
}));

beforeEach(() => {
  patches.length = 0;
  filtrosDoUpdate.length = 0;
});

describe("DELETE /api/v1/channel-sessions/[id] apaga a chave do canal arquivado", () => {
  it("conta do Instagram arquivada: token e validade zerados, filtrado pela organização", async () => {
    const { DELETE } = await import("@/app/api/v1/channel-sessions/[id]/route");
    const res = await DELETE(new NextRequest("http://x/api/v1/channel-sessions/S1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "S1" }),
    });

    expect(res.status).toBe(200);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      archived_at: expect.any(String),
      ig_token_encrypted: null,
      ig_token_expires_at: null,
      meta_token_encrypted: null,
    });
    expect(filtrosDoUpdate).toContainEqual(["organization_id", "ORG"]);
  });
});
