/**
 * A BUSCA DO FUNIL ACOMPANHA O FILTRO (auditoria 16/11, achado 26).
 *
 * O filtro do quadro mora na URL, e a caixa de busca guarda o texto em estado
 * próprio (é onde mora o atraso de 250 ms). Dois defeitos nasciam disso:
 *
 *  1. quem limpa o filtro POR FORA da caixa ("Limpar filtros" do aviso de
 *     quadro vazio, o voltar do navegador) zerava a URL e a caixa continuava
 *     mostrando o texto — a tela afirmava uma busca que não valia mais;
 *  2. o atraso mandava a busca com o filtro do render em que a tecla foi
 *     digitada: trocar Situação dentro dos 250 ms era desfeito.
 *
 * O arnês é a página em miniatura: ela é a dona do filtro e o muda por fora.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LeadFilters } from "@/lib/kanban/filters";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-1" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));

const { FilterBar } = await import("@/components/kanban/FilterBar");

function Arnes() {
  const [filters, setFilters] = useState<LeadFilters>({});
  return (
    <>
      <FilterBar filters={filters} onChange={setFilters} leads={[]} />
      <span data-testid="aplicado">{JSON.stringify(filters)}</span>
      <button onClick={() => setFilters({})}>Limpar por fora</button>
      <button onClick={() => setFilters((f) => ({ ...f, status: "won" }))}>Só ganhos</button>
    </>
  );
}

const aplicado = () => JSON.parse(screen.getByTestId("aplicado").textContent ?? "{}") as LeadFilters;

afterEach(cleanup);

describe("busca do funil x filtro na URL", () => {
  it("limpar o filtro por fora esvazia a caixa", async () => {
    const user = userEvent.setup();
    render(<Arnes />);
    const caixa = screen.getByPlaceholderText("Buscar por nome…");
    await user.type(caixa, "Joana");
    await waitFor(() => expect(aplicado().search).toBe("Joana"));

    await user.click(screen.getByRole("button", { name: "Limpar por fora" }));
    expect(caixa).toHaveValue("");
    // E a caixa vazia não ressuscita a busca depois do atraso.
    await new Promise((r) => setTimeout(r, 300));
    expect(aplicado().search).toBeUndefined();
  });

  it("trocar a Situação durante o atraso não é desfeito pela busca", async () => {
    const user = userEvent.setup();
    render(<Arnes />);
    await user.type(screen.getByPlaceholderText("Buscar por nome…"), "Joana");
    await user.click(screen.getByRole("button", { name: "Só ganhos" }));
    await waitFor(() => expect(aplicado().search).toBe("Joana"));
    expect(aplicado().status).toBe("won");
  });

  it("controle: a URL que chega com o texto já enviado não apaga o que se continuou digitando", async () => {
    const user = userEvent.setup();
    render(<Arnes />);
    const caixa = screen.getByPlaceholderText("Buscar por nome…");
    await user.type(caixa, "Jo");
    await waitFor(() => expect(aplicado().search).toBe("Jo"));
    await user.type(caixa, "ana");
    expect(caixa).toHaveValue("Joana");
    await waitFor(() => expect(aplicado().search).toBe("Joana"));
  });
});
