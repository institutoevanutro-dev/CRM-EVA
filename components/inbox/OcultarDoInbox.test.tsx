import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const papel = vi.hoisted(() => ({ role: "agent" as "viewer" | "agent" | "manager" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1", support: null }, activeOrg: { orgId: "org-1", role: papel.role } }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { OcultarDoInbox } from "./OcultarDoInbox";

const CONTATO = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

function dublarFetch() {
  const spy = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function montar(props: Partial<Parameters<typeof OcultarDoInbox>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OcultarDoInbox contactId={CONTATO} nome="Amigo do perfil" oculto={false} variante="botao" {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  papel.role = "agent";
});

/**
 * Ocultar do Inbox (migration 0372): quem atende oculta, com a pergunta que diz
 * tudo o que muda; quem gerencia traz de volta. Viewer não vê botão nenhum.
 */
describe("OcultarDoInbox", () => {
  it("o atendente oculta pela conversa só depois de confirmar", async () => {
    const fetch = dublarFetch();
    montar({ conversationId: CONVERSA, variante: "icone" });
    fireEvent.click(screen.getByRole("button", { name: "Ocultar do Inbox" }));
    const dialogo = await screen.findByTestId("ocultar-do-inbox-dialogo");
    expect(dialogo).toHaveTextContent("A IA não responde");
    expect(dialogo).toHaveTextContent("as mensagens continuam guardadas");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("ocultar-do-inbox-confirmar"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes(`/api/v1/conversations/${CONVERSA}/ocultar`) &&
            (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("pela ficha, oculta pelo contato", async () => {
    const fetch = dublarFetch();
    montar();
    fireEvent.click(screen.getByTestId("ocultar-do-inbox"));
    fireEvent.click(await screen.findByTestId("ocultar-do-inbox-confirmar"));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => String(url).includes(`/api/v1/contacts/${CONTATO}/ocultar`))).toBe(true),
    );
  });

  it("contato oculto: o gerente traz de volta; o atendente não tem botão", async () => {
    const fetch = dublarFetch();
    montar({ oculto: true });
    expect(screen.queryByTestId("mostrar-no-inbox")).toBeNull();
    cleanup();

    papel.role = "manager";
    montar({ oculto: true });
    fireEvent.click(screen.getByTestId("mostrar-no-inbox"));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes(`/api/v1/contacts/${CONTATO}/ocultar`) &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("viewer não vê nada", () => {
    papel.role = "viewer";
    const { container } = montar();
    expect(container.textContent).toBe("");
  });
});
