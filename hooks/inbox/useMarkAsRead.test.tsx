import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Item 31 da auditoria de 17/11: a conversa aberta só vira "lida" com a aba à
 * vista. Escondida, o relógio espera ela voltar.
 */

const post = vi.fn(async () => ({ data: {} }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: () => post() } }));
let podeResponder = true;
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1" } }),
  usePermission: () => podeResponder,
}));

import { useMarkAsRead } from "./useMarkAsRead";

let visibilidade: DocumentVisibilityState = "visible";
function mudarVisibilidade(v: DocumentVisibilityState) {
  visibilidade = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

function montar(responsavel: string | null = null) {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMarkAsRead("conv-1", 2, responsavel), { wrapper });
}

describe("useMarkAsRead — só com a aba à vista", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockClear();
    podeResponder = true;
    visibilidade = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilidade);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aba à vista: marca depois de 1,5 s", async () => {
    montar();
    await act(async () => vi.advanceTimersByTime(1600));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("⭐ aba escondida: não marca; ao voltar, conta de novo do zero", async () => {
    visibilidade = "hidden";
    montar();
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(post).not.toHaveBeenCalled();

    act(() => mudarVisibilidade("visible"));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(post).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(600));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a aba que se esconde no meio da espera cancela a marcação", async () => {
    montar();
    await act(async () => vi.advanceTimersByTime(1000));
    act(() => mudarVisibilidade("hidden"));
    await act(async () => vi.advanceTimersByTime(5000));
    expect(post).not.toHaveBeenCalled();
  });

  it("quem só visualiza não marca (a rota recusaria)", async () => {
    podeResponder = false;
    montar();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(post).not.toHaveBeenCalled();
  });

  it("⭐ conversa de outra pessoa: quem só abre para conferir não marca", async () => {
    montar("u-2");
    await act(async () => vi.advanceTimersByTime(5000));
    expect(post).not.toHaveBeenCalled();
  });

  it("conversa minha: marca", async () => {
    montar("u-1");
    await act(async () => vi.advanceTimersByTime(1600));
    expect(post).toHaveBeenCalledTimes(1);
  });
});
