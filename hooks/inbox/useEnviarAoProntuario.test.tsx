import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { Message } from "@/lib/types/messaging";

import { useEnviarAoProntuario } from "./useEnviarAoProntuario";

const post = vi.hoisted(() => vi.fn());
const showApiError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("sonner", () => ({ toast: { success: (m: string) => toastSuccess(m), error: vi.fn() } }));

const CONV = "c0000000-0000-4000-8000-000000000001";
const MSG = { id: "a0000000-0000-4000-8000-000000000001" } as Message;
let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const resposta = (ja_existia: boolean) => ({
  data: { message_id: MSG.id, ja_existia, enviado_em: "2026-11-04T12:00:00.000Z", enviado_por_user_id: "u" },
});

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["messages", CONV], { pages: [{ data: [{ ...MSG, body: "x" }] }], pageParams: [undefined] });
});

describe("useEnviarAoProntuario", () => {
  it("duplo clique = 1 POST, com 45 s de prazo; emVoo redesenha", async () => {
    let solta!: (v: unknown) => void;
    post.mockReturnValueOnce(new Promise((r) => (solta = r)));
    const { result } = renderHook(() => useEnviarAoProntuario(CONV), { wrapper });
    let a!: Promise<void>;
    act(() => {
      a = result.current.enviar(MSG);
      void result.current.enviar(MSG);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(`/api/v1/messages/${MSG.id}/prontuario`, null, { timeoutMs: 45000 });
    expect(result.current.emVoo.has(MSG.id)).toBe(true);
    await act(async () => {
      solta(resposta(false));
      await a;
    });
    expect(result.current.emVoo.has(MSG.id)).toBe(false);
  });

  it("201 → toast de enviado e selo no cache; 200 ja_existia → toast de já estava", async () => {
    post.mockResolvedValueOnce(resposta(false));
    const { result } = renderHook(() => useEnviarAoProntuario(CONV), { wrapper });
    await act(() => result.current.enviar(MSG));
    expect(toastSuccess).toHaveBeenLastCalledWith("Exame enviado ao prontuário.");
    const cache = qc.getQueryData<{ pages: { data: Message[] }[] }>(["messages", CONV]);
    expect(cache?.pages[0]?.data[0]?.prontuario_exame).toEqual({ ja_existia: false, enviado_em: "2026-11-04T12:00:00.000Z", enviado_por_user_id: "u" });
    post.mockResolvedValueOnce(resposta(true));
    await act(() => result.current.enviar(MSG));
    expect(toastSuccess).toHaveBeenLastCalledWith("Este exame já estava no prontuário.");
  });

  it("erro → showApiError, frase guardada no balão e invalidação; nova tentativa limpa", async () => {
    const inval = vi.spyOn(qc, "invalidateQueries");
    post.mockRejectedValueOnce(new ApiError(409, "paciente_nao_vinculado", undefined, "r", "Frase da rota."));
    const { result } = renderHook(() => useEnviarAoProntuario(CONV), { wrapper });
    await act(() => result.current.enviar(MSG));
    expect(showApiError).toHaveBeenCalled();
    expect(result.current.ultimoErro.get(MSG.id)).toBe("Frase da rota.");
    expect(inval).toHaveBeenCalledWith({ queryKey: ["messages", CONV] });
    let solta!: (v: unknown) => void;
    post.mockReturnValueOnce(new Promise((r) => (solta = r)));
    let p!: Promise<void>;
    act(() => {
      p = result.current.enviar(MSG);
    });
    expect(result.current.ultimoErro.has(MSG.id)).toBe(false);
    await act(async () => {
      solta(resposta(false));
      await p;
    });
  });
});
