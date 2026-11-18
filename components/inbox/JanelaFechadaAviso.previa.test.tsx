/**
 * Item 42 da auditoria de 17/11: o modelo aparecia pelo nome técnico
 * ("confirmacao_v2 (pt_BR) · 1 parâmetro(s)") e sem prévia. Agora a opção
 * mostra o começo do texto, e o texto inteiro aparece com os campos no lugar —
 * marcado "campo 1" enquanto vazio, com o valor quando preenchido.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({
    data: {
      data: {
        templates: [
          {
            name: "confirmacao_v2",
            language: "pt_BR",
            status: "APPROVED",
            slots: [{ key: "1", expects: "text", onde: "corpo", valueKey: "1" }],
            components: [{ type: "BODY", text: "Olá {{1}}, sua consulta está confirmada." }],
          },
        ],
      },
    },
  }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/templates-fonte", () => ({
  fonteDeTemplates: () => "oficial",
  rotaDeTemplates: () => "/api/v1/channels/templates",
}));

import { JanelaFechadaAviso } from "./JanelaFechadaAviso";

describe("item 42 — o modelo pelo texto, com prévia", () => {
  it("⭐ a opção mostra o texto (não o nome técnico) e a prévia preenche o campo", () => {
    render(<JanelaFechadaAviso conversationId="c1" provider="x" motivo="Janela fechada." />);
    const seletor = screen.getByRole("combobox", { name: "Modelo aprovado" });
    const opcao = within(seletor).getByRole("option", { name: /Olá \{\{1\}\}, sua consulta/ });
    expect(opcao.textContent).not.toMatch(/confirmacao_v2|parâmetro/);

    fireEvent.change(seletor, { target: { value: "confirmacao_v2|pt_BR" } });
    const previa = screen.getByTestId("previa-do-modelo");
    expect(previa).toHaveTextContent("Olá campo 1, sua consulta está confirmada.");

    fireEvent.change(screen.getByRole("textbox", { name: "Campo 1 do texto" }), { target: { value: "Ana" } });
    expect(previa).toHaveTextContent("Olá Ana, sua consulta está confirmada.");
  });
});
