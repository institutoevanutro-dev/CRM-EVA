/**
 * Achado 1 (crítico) da revisão da Task 8, lado do FRONT.
 *
 * `POST /:id/publicar` pode devolver HTTP 200 com `gravado: false`: a
 * publicação SAIU no Instagram, mas o UPDATE do desfecho no banco falhou. O
 * hook só olhava o status HTTP — `onSuccess` invalidava a query e ponto,
 * `onError` nunca dispara porque a resposta É 200. O comentário volta à fila
 * como `esperando_voce` de novo (o servidor não mudou o que devolve em
 * `situacao` neste ramo), Publicar continua disponível, e para o operador é
 * indistinguível de "não cliquei ainda". Um segundo clique manda uma SEGUNDA
 * resposta pública de verdade para o cliente.
 *
 * Este teste prova que o hook DISTINGUE os dois 200: um aviso próprio quando
 * `gravado === false`, silêncio (só invalida a query) quando `gravado === true`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
const toastFalso = vi.hoisted(() => Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastFalso }));

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePublicarComentario } from "@/hooks/comentarios/useComentarios";

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

describe("usePublicarComentario — 200 com gravado:false não é sucesso silencioso", () => {
  it("gravado: false — mostra um aviso próprio (a publicação JÁ SAIU), e não deixa como se nada tivesse acontecido", async () => {
    post.mockResolvedValueOnce({
      data: { id: "c1", situacao: "esperando_voce", resposta_publica_id: "reply-1", gravado: false },
    });

    const { result } = renderHook(() => usePublicarComentario(), { wrapper });
    await act(() => result.current.mutateAsync({ id: "c1", texto: "Te chamamos no Direct!" }));

    expect(toastFalso.warning).toHaveBeenCalledTimes(1);
    // O texto tem de dizer que JÁ SAIU — "sucesso genérico" levaria a clicar de novo.
    expect(String(toastFalso.warning.mock.calls[0]![0])).toMatch(/já foi publicada/i);
    expect(showApiError).not.toHaveBeenCalled();
  });

  it("gravado: true — nenhum aviso extra, só o caminho feliz de sempre", async () => {
    post.mockResolvedValueOnce({
      data: { id: "c1", situacao: "respondido_manualmente", resposta_publica_id: "reply-1", gravado: true },
    });

    const { result } = renderHook(() => usePublicarComentario(), { wrapper });
    await act(() => result.current.mutateAsync({ id: "c1", texto: "Te chamamos no Direct!" }));

    expect(toastFalso.warning).not.toHaveBeenCalled();
    expect(showApiError).not.toHaveBeenCalled();
  });
});
