/**
 * Ação de campanha que FALHA também recarrega a campanha: preparar sem ninguém
 * no recorte devolve o rascunho com o motivo gravado (auditoria de 17/11/2026,
 * item 24), e a tela só mostrava o motivo depois de um F5.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(async () => Promise.reject(new Error("campanha_sem_audiencia"))) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { useAcaoDeCampanha } from "./useCampanhas";

describe("useAcaoDeCampanha", () => {
  it("recarrega a campanha também quando a ação falha", async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const recarregar = vi.spyOn(qc, "invalidateQueries");
    const envolver = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAcaoDeCampanha("c1"), { wrapper: envolver });

    act(() => result.current.mutate({ acao: "preparar" }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(recarregar).toHaveBeenCalledWith({ queryKey: ["campanha", "c1"] });
  });
});
