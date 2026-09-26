/**
 * "Liberar" devolve a conversa ao AUTOMÁTICO: a rota chama
 * `fn_conversation_assign` com `reason: "release"`, e desde a 0173 isso limpa
 * `bot_silenced_until`.
 *
 * Num canal onde a IA nunca responde (o Instagram, `iaResponde: false`), isso
 * tira a conversa da Fila e não põe ninguém no lugar: o `ai-response-worker`
 * sai com `canal_sem_ia` e o lead fica esperando um atendimento automático que
 * não existe. Esconder o botão não basta — MCP, API e integração não passam
 * pela tela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => undefined),
}));

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";

function stub(provider: string, rpcCalls: string[]) {
  const linha = {
    id: CONV_ID,
    organization_id: ORG_ID,
    contact_id: "ct-1",
    assigned_to_user_id: AGENT_ID,
    channel_sessions: { provider },
  };
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    update: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: linha, error: null }),
    single: () => Promise.resolve({ data: linha, error: null }),
  });
  return {
    from: () => chain,
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return { data: [linha], error: null };
    },
  };
}

function sessao(provider: string, rpcCalls: string[]) {
  const user: AuthUser = {
    id: AGENT_ID,
    email: "agent@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "agent" }],
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "agent" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(stub(provider, rpcCalls) as any);
}

const req = () =>
  new NextRequest(`http://localhost/api/v1/conversations/${CONV_ID}/release`, { method: "POST" });
const ctx = { params: Promise.resolve({ id: CONV_ID }) };

beforeEach(() => vi.clearAllMocks());

describe("POST /conversations/:id/release num canal sem IA", () => {
  it("Instagram: recusa, e NÃO chama a RPC que devolveria ao automático", async () => {
    const chamadas: string[] = [];
    sessao(CHANNEL_PROVIDER_INSTAGRAM, chamadas);
    const { POST } = await import("@/app/api/v1/conversations/[id]/release/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(422);
    expect(chamadas).not.toContain("fn_conversation_assign");
    const corpo = (await res.json()) as { error?: { message?: string } };
    expect(corpo.error?.message ?? "").toMatch(/equipe|automático/i);
  });

  it("controle: no WhatsApp a liberação segue funcionando", async () => {
    const chamadas: string[] = [];
    sessao(CHANNEL_PROVIDER_WAHA, chamadas);
    const { POST } = await import("@/app/api/v1/conversations/[id]/release/route");
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(chamadas).toContain("fn_conversation_assign");
  });
});
