import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AmostrasDePaleta } from "@/components/branding/AmostrasDePaleta";

afterEach(cleanup);

describe("AmostrasDePaleta", () => {
  it("mostra as 6 paletas como botões e marca a da cor atual, sem ligar para maiúsculas", () => {
    render(<AmostrasDePaleta hex=" #6B2737 " onEscolher={() => {}} />);
    const botoes = screen.getAllByRole("button");
    expect(botoes).toHaveLength(6);
    for (const b of botoes) expect(b).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: /Vinho/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Grafite/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByText("Cor livre")).toBeNull();
  });

  it("clicar ou usar o teclado chama onEscolher com a principal", async () => {
    const onEscolher = vi.fn();
    render(<AmostrasDePaleta hex="" onEscolher={onEscolher} />);
    await userEvent.click(screen.getByRole("button", { name: /Lavanda/ }));
    expect(onEscolher).toHaveBeenLastCalledWith("#4f3f7a");
    screen.getByRole("button", { name: /Terracota/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onEscolher).toHaveBeenLastCalledWith("#8a3f26");
    screen.getByRole("button", { name: /Grafite/ }).focus();
    await userEvent.keyboard(" ");
    expect(onEscolher).toHaveBeenLastCalledWith("#3a3f47");
  });

  it("dentro de um form, escolher não envia o form", async () => {
    const enviar = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={enviar}>
        <AmostrasDePaleta hex="" onEscolher={() => {}} />
      </form>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Vinho/ }));
    expect(enviar).not.toHaveBeenCalled();
  });

  // "abc" sem cerquilha é hex válido para o campo (ehHexValido), então não serve de exemplo de inválido.
  it("hex válido que não é paleta diz Cor livre; vazio ou inválido não marca nada nem diz Cor livre", () => {
    const { rerender } = render(<AmostrasDePaleta hex="#506d48" onEscolher={() => {}} />);
    expect(screen.getByText("Cor livre")).toBeInTheDocument();
    for (const v of ["", "#12", "xyz", "#6b273"]) {
      rerender(<AmostrasDePaleta hex={v} onEscolher={() => {}} />);
      expect(screen.queryByText("Cor livre")).toBeNull();
      for (const b of screen.getAllByRole("button"))
        expect(b).toHaveAttribute("aria-pressed", "false");
    }
  });
});
