import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * "Mostrar na barra do Inbox" (migration 0398). Portado do projeto original
 * (DeskcommCRM, PR #3311 de @webtecnica, issue #3282).
 *
 * Só o `false` EXPLÍCITO tira a resposta da barra; ausente ou `true`, ela
 * aparece — a organização que nunca mexeu continua vendo tudo. O atalho `/`
 * não passa por aqui e segue listando todas.
 */
import { BarraDeRecursos, respostasDaBarra } from "@/components/inbox/composer/BarraDeRecursos";

const base = { body: "x", shortcut: null, owner_user_id: null };
const RESPOSTAS = [
  { ...base, id: "a", title: "Sem marcação" },
  { ...base, id: "b", title: "Ligada", mostrar_na_barra: true },
  { ...base, id: "c", title: "Só no atalho", mostrar_na_barra: false },
];

describe("a barra mostra só as respostas marcadas", () => {
  it("ausência e true aparecem; false some", () => {
    expect(respostasDaBarra(RESPOSTAS).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("a contagem e os botões da barra excluem a desmarcada", () => {
    render(<BarraDeRecursos respostas={RESPOSTAS} onEscolher={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Respostas rápidas \(2\)/ }));
    expect(screen.getByRole("button", { name: "Ligada" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Só no atalho" })).toBeNull();
  });

  it("com todas desmarcadas, a barra não aparece", () => {
    const { container } = render(
      <BarraDeRecursos respostas={[RESPOSTAS[2]!]} onEscolher={vi.fn()} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
