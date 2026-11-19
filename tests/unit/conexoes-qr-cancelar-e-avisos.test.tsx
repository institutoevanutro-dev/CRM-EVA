/**
 * Conexões › QR (auditoria 17/11, itens 117, 120 e 122).
 *
 *  - 117: fechar o QR de uma conexão NOVA sem escanear deixava um número
 *    pendente que nunca pareia. Agora pergunta "Cancelar esta conexão?" e apaga.
 *  - 120: celular já ligado em outro cartão dava "WhatsApp conectado!", e a
 *    verificação de saúde que falhava terminava calada.
 *  - 122: nome interno da sessão (`org_…`) e variáveis do servidor na tela de
 *    quem não administra a instalação.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: (...a: unknown[]) => deleteMock(...a),
  },
}));

const toastOk = vi.fn();
const toastErro = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) },
}));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({ usePacingKnobs: () => ({ data: { items: [] } }) }));
vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem = { data: [] as ChannelSession[] | undefined, isLoading: false, isError: false, schemaOutdated: false };
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import { ConnectionsClient } from "@/components/connections/ConnectionsClient";
import { channelLabel } from "@/hooks/channels/useChannelSessions";
import { rotuloDaQualidade, rotuloDoEstadoDoModelo } from "@/lib/channels/estado";

const CANAL: ChannelSession = {
  id: "canal-1",
  waha_session_name: "org_1111_aaa",
  display_name: "Vendas",
  phone_number: "5527990000000",
  status: "WORKING",
  status_reason: null,
  last_health_check_at: null,
  last_status_change_at: null,
  daily_message_limit: 250,
  is_warmup_complete: null,
  created_at: "2026-08-01T00:00:00Z",
};

let resposta: { status: string; phone_number_conflict?: boolean } | "ERRO";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const fecharDialogo = () => fireEvent.click(screen.getByRole("button", { name: "Close" }));

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  deleteMock.mockReset();
  toastOk.mockReset();
  toastErro.mockReset();
  listagem.data = [];
  resposta = { status: "SCAN_QR_CODE" };
  postMock.mockImplementation((url: string) =>
    Promise.resolve(url === "/api/v1/channel-sessions" ? { data: { ...CANAL, id: "novo-1" } } : { data: {} }),
  );
  deleteMock.mockResolvedValue({ data: { id: "novo-1", archived: false } });
  getMock.mockImplementation((url: string) => {
    if (/\/api\/v1\/channel-sessions\/[^/?]+$/.test(url)) {
      return resposta === "ERRO" ? Promise.reject(new Error("fora do ar")) : Promise.resolve({ data: resposta });
    }
    return Promise.resolve({ data: {} });
  });
});
afterEach(() => cleanup());

describe("item 117 — fechar o QR de uma conexão nova", () => {
  it("pergunta e, confirmado, apaga o número pendente", async () => {
    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo WhatsApp/ }));
    await screen.findByText("Conectar novo WhatsApp", { selector: "h2" });

    fecharDialogo();
    expect(await screen.findByText("Cancelar esta conexão?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancelar conexão" }));
    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/api/v1/channel-sessions/novo-1"));
    expect(toastOk).toHaveBeenCalledWith("Conexão cancelada.");
  });

  it("'Voltar ao código' mantém a conexão e não apaga nada", async () => {
    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo WhatsApp/ }));
    await screen.findByText("Conectar novo WhatsApp", { selector: "h2" });

    fecharDialogo();
    fireEvent.click(await screen.findByRole("button", { name: "Voltar ao código" }));
    expect(await screen.findByText("Conectar novo WhatsApp", { selector: "h2" })).toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("reconectar um número existente fecha sem perguntar", async () => {
    listagem.data = [CANAL];
    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: /Reconectar/ }));
    await screen.findByText(/Reconectar Vendas/);

    fecharDialogo();
    await waitFor(() => expect(screen.queryByText(/Reconectar Vendas/)).not.toBeInTheDocument());
    expect(screen.queryByText("Cancelar esta conexão?")).not.toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("item 120 — os dois avisos que faltavam", () => {
  it("celular já ligado em outro cartão não vira 'WhatsApp conectado!'", async () => {
    resposta = { status: "WORKING", phone_number_conflict: true };
    render(wrap(<ConnectionsClient wahaConfigured />));
    fireEvent.click(screen.getByRole("button", { name: /Conectar novo WhatsApp/ }));

    await waitFor(() =>
      expect(toastErro).toHaveBeenCalledWith(
        "Este celular já está conectado em outro número desta lista. Exclua um dos dois.",
      ),
    );
    expect(toastOk).not.toHaveBeenCalledWith("WhatsApp conectado!");
  });

  it("verificação de saúde que falha avisa, em vez de terminar calada", async () => {
    resposta = "ERRO";
    listagem.data = [CANAL];
    render(wrap(<ConnectionsClient wahaConfigured />));
    await waitFor(() =>
      expect(toastErro).toHaveBeenCalledWith("Não foi possível verificar todos os números. Tente de novo."),
    );
  });
});

describe("item 122 — textos técnicos", () => {
  it("número pendente não aparece como o nome interno da sessão", () => {
    expect(channelLabel({ display_name: null, phone_number: null })).toBe("Número sem nome");
  });

  it("a variável do servidor só aparece para quem administra a instalação", () => {
    const { unmount } = render(wrap(<ConnectionsClient wahaConfigured={false} />));
    expect(screen.queryByText("WAHA_API_BASE_URL")).not.toBeInTheDocument();
    expect(screen.getByText(/Peça a quem administra a instalação/)).toBeInTheDocument();
    unmount();

    render(wrap(<ConnectionsClient wahaConfigured={false} adminDaInstalacao />));
    expect(screen.getByText("WAHA_API_BASE_URL")).toBeInTheDocument();
  });

  it("estado do modelo e qualidade do número em português", () => {
    expect(rotuloDoEstadoDoModelo("APPROVED")).toBe("Aprovado");
    expect(rotuloDoEstadoDoModelo("pending")).toBe("Em análise");
    expect(rotuloDoEstadoDoModelo("OUTRO")).toBe("Situação desconhecida");
    expect(rotuloDaQualidade("GREEN")).toBe("Alta");
    expect(rotuloDaQualidade(null)).toBe("Sem nota");
  });
});
