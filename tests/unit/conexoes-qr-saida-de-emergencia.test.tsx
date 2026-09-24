/**
 * Central de Conexões — a saída da tela do QR não pode depender de SORTE.
 *
 * Defeito medido em 23/09/2026 na instalação do Instituto Eva, reconectando dois
 * canais cuja credencial tinha sido revogada. O WAHA entrou em laço
 * `STARTING` → `Error: Connection Failure` → `Session stuck in STARTING status,
 * force stopping the session` → `STARTING`, e a tela só oferecia "Gerar novo QR"
 * — a única ação que resolve credencial revogada — quando a sondagem de 3s por
 * acaso observava `FAILED`/`STOPPED`:
 *
 *  - 5527999049879: a sondagem pegou o FAILED, o botão apareceu, fim.
 *  - 5527998659879: nunca pegou. Mais de 60s em "Preparando o código…", sem
 *    saída, até a chamada com `{force:true}` ser disparada à mão pelo console.
 *
 * É corrida, não código faltando. Estes casos existem para que a saída volte a
 * depender só do estado instantâneo POR CIMA DE UM TESTE VERMELHO.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import type { ChannelSession } from "@/hooks/channels/useChannelSessions";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
    delete: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/channels/usePacingKnobs", () => ({ usePacingKnobs: () => ({ data: { items: [] } }) }));
vi.mock("@/components/connections/AntiBanSheet", () => ({ AntiBanSheet: () => null }));

const listagem = { data: [] as ChannelSession[] | undefined, isLoading: false, isError: false, schemaOutdated: false };
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => listagem };
});

import {
  ConnectionsClient,
  ofereceNovoPareamento,
  SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO,
} from "@/components/connections/ConnectionsClient";

const CANAL: ChannelSession = {
  id: "canal-1",
  waha_session_name: "org_1111_aaa",
  display_name: "Vendas",
  phone_number: "5527998659879",
  status: "FAILED",
  status_reason: null,
  last_health_check_at: null,
  last_status_change_at: null,
  daily_message_limit: 250,
  is_warmup_complete: null,
  created_at: "2026-08-01T00:00:00Z",
};

/**
 * O que o transporte responde AGORA. Estado mutável, e não fila consumida por
 * chamada, de propósito: o efeito de sondagem pode remontar (e descartar a
 * resposta em voo, como faz em produção), e uma fila daria ao teste uma ordem
 * que o componente não garante.
 */
let statusNoTransporte: string | "ERRO";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/** Abre o diálogo do QR pelo botão Reconectar, como o operador faz. */
async function abrirODialogoDoQr() {
  render(wrap(<ConnectionsClient wahaConfigured />));
  fireEvent.click(screen.getByRole("button", { name: /Reconectar/ }));
  await waitFor(() => expect(screen.getByText(/Preparando o código…|Gerar novo QR/)).toBeInTheDocument());
}

const saidaOferecida = () => screen.queryByRole("button", { name: /Gerar novo QR/ }) !== null;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getMock.mockReset();
  postMock.mockReset();
  listagem.data = [CANAL];
  statusNoTransporte = "STARTING";
  postMock.mockResolvedValue({ data: {} });
  getMock.mockImplementation((url: string) => {
    if (typeof url === "string" && /\/api\/v1\/channel-sessions\/[^/]+$/.test(url)) {
      if (statusNoTransporte === "ERRO") return Promise.reject(new Error("waha fora do ar"));
      return Promise.resolve({ data: { status: statusNoTransporte } });
    }
    return Promise.resolve({ data: {} });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("laço STARTING que a sondagem nunca vê falhar", () => {
  it("oferece o novo pareamento depois da espera, mesmo sem nunca observar FAILED", async () => {
    await abrirODialogoDoQr();

    // Metade da espera: ainda é cedo. Oferecer o `force` aqui custaria um
    // reescaneamento a cada queda passageira — que é o que o modo suave evita.
    await vi.advanceTimersByTimeAsync((SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO / 2) * 1000);
    expect(saidaOferecida()).toBe(false);

    await vi.advanceTimersByTimeAsync((SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO / 2 + 6) * 1000);
    expect(saidaOferecida()).toBe(true);
    expect(screen.getByText(/O código não veio/)).toBeInTheDocument();
  });

  it("o clique dispara o force, que é a única ação que resolve credencial revogada", async () => {
    await abrirODialogoDoQr();
    await vi.advanceTimersByTimeAsync((SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO + 6) * 1000);

    fireEvent.click(screen.getByRole("button", { name: /Gerar novo QR/ }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1/reconnect", { force: true }),
    );
  });

  it("sondagem que só dá erro também chega à saída — serviço fora do ar é beco igual", async () => {
    statusNoTransporte = "ERRO";
    await abrirODialogoDoQr();

    await vi.advanceTimersByTimeAsync((SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO + 6) * 1000);
    expect(saidaOferecida()).toBe(true);
  });
});

describe("o que a espera NÃO pode atropelar", () => {
  it("QR já mostrado e depois oscilando: o relógio não oferece o force", async () => {
    // Quem demora depois do QR na tela é o humano pegando o celular. Forçar aqui
    // cobraria um reescaneamento de quem estava só escaneando.
    statusNoTransporte = "SCAN_QR_CODE";
    await abrirODialogoDoQr();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(screen.getByAltText(/QR Code/)).toBeInTheDocument();

    // O laço volta a STARTING, e a sondagem nunca mais vê um estado terminal.
    statusNoTransporte = "STARTING";
    await vi.advanceTimersByTimeAsync((SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO + 30) * 1000);
    expect(saidaOferecida()).toBe(false);
  });

  it("FAILED observado continua oferecendo a saída na hora, sem esperar o relógio", async () => {
    statusNoTransporte = "FAILED";
    await abrirODialogoDoQr();

    await vi.advanceTimersByTimeAsync(3_500);
    expect(saidaOferecida()).toBe(true);
    expect(screen.getByText(/foi desvinculado do WhatsApp/)).toBeInTheDocument();
  });
});

describe("a régua, sem DOM", () => {
  const caso = (over: Partial<Parameters<typeof ofereceNovoPareamento>[0]>) =>
    ofereceNovoPareamento({ status: "STARTING", viuQr: false, segundosEsperando: 0, ...over });

  it("o limite é fechado no valor declarado", () => {
    expect(caso({ segundosEsperando: SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO - 1 })).toBe(false);
    expect(caso({ segundosEsperando: SEGUNDOS_ATE_OFERECER_NOVO_PAREAMENTO })).toBe(true);
  });

  it("estado terminal vence o relógio; QR visto e conexão viva o desligam", () => {
    expect(caso({ status: "FAILED" })).toBe(true);
    expect(caso({ status: "STOPPED" })).toBe(true);
    expect(caso({ status: "WORKING", segundosEsperando: 9_999 })).toBe(false);
    expect(caso({ status: "SCAN_QR_CODE", segundosEsperando: 9_999 })).toBe(false);
    expect(caso({ viuQr: true, segundosEsperando: 9_999 })).toBe(false);
  });
});
