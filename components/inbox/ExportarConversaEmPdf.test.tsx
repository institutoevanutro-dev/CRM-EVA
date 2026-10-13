/**
 * O botão de baixar a conversa em PDF: só aparece para quem a rota aceita, diz
 * que está gerando enquanto gera, e conta ao usuário o que deu errado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const sessao = vi.hoisted(() => ({
  user: { id: "u1", support: null as unknown },
  activeOrg: { orgId: "o1", name: "Clínica", role: "agent" as string },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => sessao }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast }));

import { ExportarConversaEmPdf } from "./ExportarConversaEmPdf";

const CONV = "33333333-3333-4333-8333-333333333333";
const botao = () => screen.queryByTestId("exportar-conversa-pdf");

function respostaPdf(truncada = false): Response {
  return new Response("%PDF-1.7", {
    status: 200,
    headers: {
      "Content-Disposition": 'attachment; filename="historico-conversa-jose-2026-10-13.pdf"',
      "X-Export-Truncated": truncada ? "1" : "0",
    },
  });
}

let baixados: string[];

beforeEach(() => {
  sessao.user = { id: "u1", support: null };
  sessao.activeOrg = { orgId: "o1", name: "Clínica", role: "agent" };
  baixados = [];
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:pdf");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    baixados.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ExportarConversaEmPdf: quem vê", () => {
  it.each(["agent", "manager", "admin"])("papel %s vê o botão, com nome acessível", (role) => {
    sessao.activeOrg.role = role;
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    expect(botao()).toHaveAttribute("aria-label", "Baixar a conversa em PDF");
  });

  it.each(["viewer", "provider"])("papel %s não vê", (role) => {
    sessao.activeOrg.role = role;
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    expect(botao()).toBeNull();
  });

  it("sessão de acompanhamento do suporte não vê", () => {
    sessao.user = { id: "u1", support: { id: "s", access_mode: "full", status: "active" } };
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    expect(botao()).toBeNull();
  });
});

describe("ExportarConversaEmPdf: o clique", () => {
  it("pede o PDF da conversa certa, trava o botão enquanto gera e baixa com o nome que a rota deu", async () => {
    let liberar!: (r: Response) => void;
    const fetchFalso = vi.fn(() => new Promise<Response>((ok) => (liberar = ok)));
    vi.stubGlobal("fetch", fetchFalso);
    render(<ExportarConversaEmPdf conversationId={CONV} />);

    await userEvent.click(botao()!);
    expect(fetchFalso).toHaveBeenCalledWith(`/api/v1/conversations/${CONV}/export?formato=pdf`, { cache: "no-store" });
    expect(botao()).toBeDisabled();
    expect(botao()).toHaveAttribute("aria-busy", "true");
    expect(botao()).toHaveAttribute("aria-label", "Gerando o PDF da conversa...");

    liberar(respostaPdf());
    await waitFor(() => expect(botao()).not.toBeDisabled());
    expect(baixados).toEqual(["historico-conversa-jose-2026-10-13.pdf"]);
    expect(toast.success).toHaveBeenCalledWith("PDF da conversa baixado.");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("conversa maior que o limite: baixa e AVISA que o arquivo não tem tudo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respostaPdf(true)));
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    await userEvent.click(botao()!);
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.warning.mock.calls[0]![0]).toContain("só as mensagens mais recentes");
    expect(baixados).toHaveLength(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("recusa da rota: mostra a frase da rota, não baixa nada e destrava", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "rate_limited", message: "Muitas exportações seguidas. Tente em um minuto." } }, { status: 429 })),
    );
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    await userEvent.click(botao()!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Muitas exportações seguidas. Tente em um minuto."));
    expect(baixados).toEqual([]);
    expect(botao()).not.toBeDisabled();
  });

  it("rede caiu: erro dito e botão de volta", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    render(<ExportarConversaEmPdf conversationId={CONV} />);
    await userEvent.click(botao()!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível gerar o PDF desta conversa."));
    expect(botao()).not.toBeDisabled();
  });
});
