import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O painel "Iniciar conversa" do Inbox (porte do upstream #2838).
 *
 * O que cada caso prende:
 *  1. telefone brasileiro novo sai em E.164 para o mesmo `open-with-contact`
 *     da tabela de Contatos;
 *  2. telefone que já é de alguém REUSA a ficha (`contact_id`, sem telefone);
 *  3. a conversa é ASSUMIDA por quem iniciou antes da primeira mensagem, que é
 *     UMA, pelo `POST /api/v1/messages` de sempre;
 *  4. sem dono seu (claim recusado, ou 409 com outro atendente), a mensagem
 *     não sai;
 *  5. quem não pode atender não vê o botão.
 */
const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastInfo = vi.hoisted(() => vi.fn());
const podeMock = vi.hoisted(() => vi.fn(() => true));
const showApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: getMock, post: postMock, put: vi.fn(), patch: vi.fn(), del: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: toastInfo } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: showApiErrorMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => podeMock(),
  useAuth: () => ({ user: { id: "eu" } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));

import { BotaoIniciarConversa } from "@/components/inbox/PainelIniciarConversa";
import { ApiError } from "@/lib/api/types";

function contato(id: string, name: string, phone_number: string) {
  return { id, name, display_name: null, phone_number, email: null, is_anonymized: false, created_at: "2026-01-01T00:00:00.000Z" };
}

function lerContatos(contatos: ReturnType<typeof contato>[], extra?: (c: string) => unknown) {
  getMock.mockImplementation(async (caminho: string) => {
    const r = extra?.(caminho);
    if (r) return r;
    if (caminho.startsWith("/api/v1/contacts")) return { data: contatos, meta: {} };
    return { data: [] };
  });
}

async function abrirComTelefone(telefone: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BotaoIniciarConversa />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Iniciar conversa" }));
  fireEvent.change(await screen.findByLabelText("Para quem"), { target: { value: telefone } });
}

const posts = () => postMock.mock.calls as unknown as Array<[string, unknown]>;

beforeEach(() => {
  for (const m of [getMock, postMock, pushMock, toastError, toastInfo, showApiErrorMock]) m.mockReset();
  podeMock.mockReturnValue(true);
  postMock.mockImplementation(async (caminho: string) =>
    caminho === "/api/v1/conversations/open-with-contact"
      ? { data: { conversation_id: "conv-9" } }
      : { data: {} },
  );
});

describe("Painel Iniciar conversa no Inbox (porte do upstream #2838)", () => {
  it("telefone novo vira E.164 e abre pelo mesmo open-with-contact", async () => {
    lerContatos([]);
    await abrirComTelefone("(11) 99999-0001");
    expect(screen.getByText(/Novo contato/)).toHaveTextContent("+5511999990001");

    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
    expect(posts()[0]).toEqual(["/api/v1/conversations/open-with-contact", { phone_number: "+5511999990001" }]);
    // Sem mensagem escrita, nada é enviado: só abrir e assumir.
    expect(posts().map(([c]) => c)).toEqual([
      "/api/v1/conversations/open-with-contact",
      "/api/v1/conversations/conv-9/claim",
    ]);
  });

  it("telefone que já é de um contato reusa a ficha: contact_id e não phone_number", async () => {
    lerContatos([contato("contato-ana", "Ana Souza", "+5511999990001")]);
    await abrirComTelefone("(11) 99999-0001");
    await waitFor(() => expect(screen.getByText(/Contato existente/)).toHaveTextContent("Ana Souza"));

    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(posts()[0]).toEqual(["/api/v1/conversations/open-with-contact", { contact_id: "contato-ana" }]);
  });

  it("assume ANTES de enviar, e envia UMA mensagem pelo caminho de sempre", async () => {
    lerContatos([]);
    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), { target: { value: "Bom dia! Podemos falar?" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-9"));
    expect(posts().slice(1)).toEqual([
      ["/api/v1/conversations/conv-9/claim", { expected_assignee: null }],
      ["/api/v1/messages", { conversation_id: "conv-9", body: "Bom dia! Podemos falar?" }],
    ]);
  });

  it("claim recusado (não 409): a mensagem NÃO sai e o erro aparece", async () => {
    lerContatos([]);
    const recusa = new ApiError(500, "internal_error", undefined, "req-1");
    postMock.mockImplementation(async (caminho: string) => {
      if (caminho.endsWith("/claim")) throw recusa;
      return { data: { conversation_id: "conv-9" } };
    });
    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(showApiErrorMock).toHaveBeenCalledWith(recusa);
    expect(posts().map(([c]) => c)).not.toContain("/api/v1/messages");
  });

  it("409 com a conversa de OUTRO atendente: a mensagem não sai e o dono é nomeado", async () => {
    lerContatos([], (c) =>
      c === "/api/v1/conversations/conv-9"
        ? { data: { assigned_to_user_id: "outra", assigned_to_user_name: "Ana" } }
        : undefined,
    );
    postMock.mockImplementation(async (caminho: string) => {
      if (caminho.endsWith("/claim")) throw new ApiError(409, "state_conflict", undefined, "req-2");
      return { data: { conversation_id: "conv-9" } };
    });
    await abrirComTelefone("(11) 99999-0001");
    fireEvent.change(screen.getByLabelText("Primeira mensagem"), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(toastInfo).toHaveBeenCalledWith("A conversa neste número está com Ana.");
    expect(posts().map(([c]) => c)).not.toContain("/api/v1/messages");
  });

  it("quem não pode atender não vê o botão", () => {
    podeMock.mockReturnValue(false);
    lerContatos([]);
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <BotaoIniciarConversa />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Iniciar conversa" })).toBeNull();
  });
});
