/**
 * Item 39 da auditoria de 17/11: sem internet, cada atualização automática do
 * Inbox mostrava o seu "Erro inesperado". Agora é UM aviso "Sem conexão" (id
 * fixo: o sonner troca em vez de empilhar), que sai quando uma leitura volta a
 * dar certo. Recusa do servidor segue pelo aviso de sempre.
 *
 * O hook da lista é o REAL; só os vizinhos (tempo real, toast) são dublês.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const showApiError = vi.hoisted(() => vi.fn());
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "subscribed", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({ divergencias: 0, ultimaDivergencia: null, ultimaVerificacao: null }),
}));
const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (url: string) => get(url) } }));

import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";
import { ID_DO_AVISO_SEM_CONEXAO } from "@/hooks/inbox/avisoSemConexao";
import { ApiError } from "@/lib/api/types";

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useConversationsRealtime({}, "org-1"), { wrapper });
}

describe("item 39 — sem conexão, um aviso só", () => {
  beforeEach(() => {
    toast.warning.mockClear();
    toast.dismiss.mockClear();
    showApiError.mockClear();
    get.mockReset();
  });

  it("⭐ duas leituras sem rede: o MESMO aviso 'Sem conexão', nenhum 'Erro inesperado'", async () => {
    get.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    await result.current.refetch();

    expect(showApiError).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(2);
    for (const [texto, opcoes] of toast.warning.mock.calls) {
      expect(texto).toMatch(/^Sem conexão/);
      expect(opcoes).toMatchObject({ id: ID_DO_AVISO_SEM_CONEXAO });
    }
  });

  it("a leitura que volta a dar certo tira o aviso", async () => {
    get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    get.mockResolvedValue({ data: [], meta: { has_more: false } });
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    await result.current.refetch();
    expect(toast.dismiss).toHaveBeenCalledWith(ID_DO_AVISO_SEM_CONEXAO);
  });

  it("recusa do servidor segue pelo aviso de sempre", async () => {
    get.mockRejectedValue(new ApiError(500, "internal_error", undefined, "req-1", "falhou"));
    const { result } = montar();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(showApiError).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
