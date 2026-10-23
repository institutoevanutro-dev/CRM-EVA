import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O COMPOSER NO CELULAR (porte dos originais #3190 e #3191).
 *
 * Campo com menos de 16px faz o Safari do iPhone AMPLIAR a página ao focar, e
 * o zoom muda a largura do `visualViewport`, o que confundia a detecção do
 * teclado da conversa em tela cheia. No toque, a tecla de retorno do teclado
 * virtual quebra linha (como no WhatsApp) e quem envia é o botão. O jsdom não
 * aplica CSS nem tem `matchMedia`: aqui ficam as guardas das classes e o dublê
 * do ponteiro; a medida em px só o navegador prova.
 */

const sendMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" contact={{ name: "Contato Fictício", display_name: null }} {...props} />
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByRole("textbox", { name: "Mensagem" });
const classes = (el: HTMLElement) => el.className.split(/\s+/);

beforeEach(() => {
  sendMock.mockClear();
});

describe("campo de mensagem com 16px no celular (porte do #3190)", () => {
  it("usa text-base abaixo do md e text-sm a partir dele", () => {
    renderComposer();
    expect(classes(campo())).toContain("text-base");
    expect(classes(campo())).toContain("md:text-sm");
    expect(classes(campo())).not.toContain("text-sm");
  });
});

describe("Enter no toque quebra linha; quem envia é o botão (porte do #3191)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function ponteiro(grosso: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (q: string) => ({ matches: grosso && q.includes("coarse"), media: q }) as MediaQueryList,
    );
  }

  it("ponteiro grosso: Enter NÃO envia e não é cancelado (o navegador quebra a linha)", () => {
    ponteiro(true);
    renderComposer();
    fireEvent.change(campo(), { target: { value: "linha 1" } });
    const naoCancelado = fireEvent.keyDown(campo(), { key: "Enter" });
    expect(naoCancelado).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ponteiro grosso + Ctrl+Enter ou Cmd+Enter envia", () => {
    ponteiro(true);
    renderComposer();
    fireEvent.change(campo(), { target: { value: "oi" } });
    fireEvent.keyDown(campo(), { key: "Enter", ctrlKey: true });
    fireEvent.change(campo(), { target: { value: "de novo" } });
    fireEvent.keyDown(campo(), { key: "Enter", metaKey: true });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("ponteiro fino (computador): Enter continua enviando, como sempre", () => {
    ponteiro(false);
    renderComposer();
    fireEvent.change(campo(), { target: { value: "oi" } });
    const naoCancelado = fireEvent.keyDown(campo(), { key: "Enter" });
    expect(naoCancelado).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Os alvos de toque: 44px abaixo do `lg` (o `size="icon"`/`sm` do Button já
 * faz isso) e o tamanho de antes a partir dele. Um `h-9`/`h-10` sem prefixo
 * voltaria a fixar o alvo pequeno no celular.
 */
describe("campo e alvos pensados para o toque (porte do #3191)", () => {
  it("o campo tem 44px de altura até o lg e encolhe na largura em vez de empurrar o Enviar", () => {
    renderComposer();
    const c = classes(campo());
    expect(c).toContain("min-h-11");
    expect(c).toContain("lg:min-h-10");
    expect(c).toContain("min-w-0");
  });

  it("Enviar, Anexar, Sugerir resposta e a porta da faixa herdam os 44px do size=icon", () => {
    renderComposer();
    fireEvent.change(campo(), { target: { value: "oi" } });
    for (const nome of ["Enviar", "Anexar", "Sugerir resposta", "Opções de resposta"]) {
      const botao = screen.getByRole("button", { name: nome });
      expect(classes(botao), nome).toContain("h-11");
      expect(classes(botao), nome).not.toContain("h-9");
      expect(classes(botao), nome).not.toContain("h-10");
    }
  });

  it("o emoji some no toque: o teclado do celular já tem", () => {
    renderComposer();
    expect(classes(screen.getByRole("button", { name: "Emoji" }))).toContain("pointer-coarse:hidden");
  });

  it("Responder e Nota interna têm 44px de altura até o lg", () => {
    renderComposer();
    for (const nome of ["Responder", "Nota interna"]) {
      const botao = screen.getByRole("button", { name: nome, hidden: true });
      expect(classes(botao), nome).toContain("min-h-11");
      expect(classes(botao), nome).toContain("lg:min-h-0");
    }
  });
});
