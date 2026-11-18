import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/shell/CommandPalette", () => ({
  CommandPalette: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Busca" /> : null),
}));

import { SearchTrigger } from "./SearchTrigger";

/** Auditoria de 17/11, item 64: no celular a busca só existia dentro da gaveta do menu. */
describe("SearchTrigger no topo do celular", () => {
  it("é uma lupa com nome, só abaixo de md, e abre a mesma busca", () => {
    render(<SearchTrigger noTopo atalho={false} />);
    const lupa = screen.getByRole("button", { name: "Buscar tela" });
    expect(lupa.className).toMatch(/\bmd:hidden\b/);
    fireEvent.click(lupa);
    expect(screen.getByRole("dialog", { name: "Busca" })).toBeInTheDocument();
  });
});
