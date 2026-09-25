/**
 * A conta do Instagram (etapa 1: só recebe) não pode aparecer nas listas de
 * "número de WhatsApp". Ela entrou em `PROVIDERS_DE_MENSAGEM` para o Inbox a
 * listar, e com isso vazou para Conexões › Números e para o destino das
 * automações, que mandariam mensagem por um canal que não envia.
 *
 * A fonte (`GET /api/v1/channel-sessions`) diz `can_send` por canal, calculado
 * pela capability; quem lista destino de envio filtra por ele.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_INSTAGRAM, CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "U1" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: "ORG" })),
  mfaEmDivida: vi.fn(async () => false),
}));

const filtros: [string, unknown][] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => {
        const q: Record<string, unknown> = {
          eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
          in: () => q,
          is: () => q,
          order: async () => ({
            data: [
              { id: "wa", display_name: "Vendas", provider: CHANNEL_PROVIDER_WAHA },
              { id: "ig", display_name: "@clinica", provider: CHANNEL_PROVIDER_INSTAGRAM },
            ],
            error: null,
          }),
        };
        return q;
      },
    }),
  }),
}));

let sessoes: ChannelSession[] = [];
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: sessoes }) };
});
vi.mock("@/hooks/ai/useAgents", () => ({ useAgentsList: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));

import { GET } from "@/app/api/v1/channel-sessions/route";
import { ActionConfigForm } from "@/app/app/webhooks/_components/ActionConfigForm";

function canal(over: Partial<ChannelSession>): ChannelSession {
  return {
    id: "wa",
    waha_session_name: "org_1",
    display_name: "Vendas",
    phone_number: "5511999999999",
    status: "WORKING",
    status_reason: null,
    last_health_check_at: null,
    last_status_change_at: null,
    daily_message_limit: 250,
    is_warmup_complete: null,
    created_at: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("GET /api/v1/channel-sessions diz quem envia", () => {
  it("can_send pela capability, sem expor o provider; filtrado pela organização da sessão", async () => {
    const corpo = (await (await GET()).json()) as { data: Record<string, unknown>[] };
    expect(corpo.data).toEqual([
      { id: "wa", display_name: "Vendas", can_send: true },
      { id: "ig", display_name: "@clinica", can_send: false },
    ]);
    expect(filtros).toContainEqual(["organization_id", "ORG"]);
  });
});

describe("Automação › Número de WhatsApp", () => {
  it("a conta do Instagram não entra como destino (nem como 'desconectada')", () => {
    sessoes = [canal({}), canal({ id: "ig", display_name: "@clinica", status: "FAILED", can_send: false })];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ActionConfigForm
          action={{ type: "send_whatsapp_message", config: { channel_session_id: "", template: "" } }}
          onChange={() => {}}
        />
      </QueryClientProvider>,
    );
    // Com a conta do Instagram na lista, a nota dos números desconectados aparecia.
    expect(screen.queryByText(/Números desconectados aparecem desabilitados/)).not.toBeInTheDocument();
  });
});
