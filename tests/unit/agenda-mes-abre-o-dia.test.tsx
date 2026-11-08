import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

/** A7 do pacote 2a de design: o Mês abre o dia e o chip abre o detalhe. Nomes fictícios. */
afterEach(cleanup);

const FUSO = "America/Sao_Paulo";
const PESSOAS: Pessoa[] = [{ id: "p1", nome: "Ana Prado", trilha: 2 }];
const em = (h: number): Pick<Agendamento, "comeca" | "termina"> => ({
  comeca: `2026-09-16T${String(h).padStart(2, "0")}:00:00-03:00`,
  termina: `2026-09-16T${String(h).padStart(2, "0")}:30:00-03:00`,
});
const AGENDAMENTOS: Agendamento[] = [
  { id: "a1", titulo: "Consulta", quemSeraAtendido: "Marina Alves", responsavelId: "p1", origem: "ui", situacao: "confirmed", ...em(9) },
  { id: "g1", titulo: "Ocupado", responsavelId: "p1", origem: "google_sync", situacao: "confirmed", ...em(10) },
  { id: "a2", titulo: "Retorno", quemSeraAtendido: "Pedro Lima", responsavelId: "p1", origem: "ui", situacao: "confirmed", ...em(11) },
];

function desenhar() {
  const onAbrirDia = vi.fn();
  const onAbrirAgendamento = vi.fn();
  render(
    <GradeDaAgenda
      visao="mes"
      ancora={new Date(2026, 8, 16, 12)}
      agora={new Date("2026-09-01T12:00:00Z")}
      fuso={FUSO}
      pessoas={PESSOAS}
      agendamentos={AGENDAMENTOS}
      onAbrirDia={onAbrirDia}
      onAbrirAgendamento={onAbrirAgendamento}
    />,
  );
  return { onAbrirDia, onAbrirAgendamento };
}

describe("Mês que abre o dia", () => {
  it("a célula é botão e abre aquele dia", () => {
    const { onAbrirDia } = desenhar();
    fireEvent.click(screen.getByTestId("abrir-dia-2026-09-16"));
    expect(onAbrirDia).toHaveBeenCalledTimes(1);
    const dia = onAbrirDia.mock.calls[0]![0] as Date;
    expect([dia.getFullYear(), dia.getMonth(), dia.getDate()]).toEqual([2026, 8, 16]);
  });

  it("o chip abre o detalhe e diz o paciente primeiro", () => {
    const { onAbrirAgendamento, onAbrirDia } = desenhar();
    const chip = screen.getByTestId("chip-mes-a1");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("aria-label")).toMatch(/^Marina Alves, Consulta, 09:00/);
    expect(chip.textContent).toContain("09:00 Marina A.");
    fireEvent.click(chip);
    expect(onAbrirAgendamento).toHaveBeenCalledWith("a1");
    expect(onAbrirDia).not.toHaveBeenCalled();
  });

  it("o chip do Google não abre", () => {
    desenhar();
    expect(screen.getByTestId("chip-mes-g1").tagName).toBe("DIV");
  });

  it("'+1' vira '+1 mais' e o celular tem pontos com o número", () => {
    desenhar();
    expect(screen.getByTestId("celula-mes-2026-09-16").textContent).toContain("+1 mais");
    expect(screen.getByTestId("pontos-mes-2026-09-16").textContent).toBe("3");
  });
});
