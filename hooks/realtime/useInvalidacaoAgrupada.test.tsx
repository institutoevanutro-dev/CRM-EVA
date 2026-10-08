import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInvalidacaoAgrupada } from "./useInvalidacaoAgrupada";

describe("useInvalidacaoAgrupada", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function montar() {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useInvalidacaoAgrupada(400, 2_000), { wrapper });
    return { invalidar: result.current, spy };
  }

  it("uma rajada vira uma invalidação por chave", () => {
    const { invalidar, spy } = montar();
    act(() => {
      for (let i = 0; i < 10; i++) invalidar(["conversations"]);
      invalidar(["messages", "c1"]);
    });
    expect(spy).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(400));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("rajada contínua não adia além do teto", () => {
    const { invalidar, spy } = montar();
    act(() => {
      for (let t = 0; t < 2_000; t += 300) {
        invalidar(["board", "p"]);
        vi.advanceTimersByTime(300);
      }
    });
    expect(spy).toHaveBeenCalled();
  });
});
