/**
 * No toque, deslizar sobre uma consulta ROLA a agenda; só o toque longo arrasta
 * (item 130 da auditoria de 17/11). Antes, `touch-none` + limiar de 4 px faziam
 * qualquer deslize do dedo abrir "Remarcar X para Y?".
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GradeDaAgenda, TOQUE_LONGO_MS } from "./GradeDaAgenda";
import type { Agendamento } from "./tipos";

const DIA = "2026-08-26";
const COMPROMISSO: Agendamento = {
  id: "a1",
  titulo: "Consulta",
  responsavelId: "p1",
  comeca: `${DIA}T14:00:00`,
  termina: `${DIA}T14:30:00`,
  origem: "ui",
  situacao: "confirmed",
};

function montar() {
  render(
    <GradeDaAgenda
      visao="dia"
      ancora={new Date(`${DIA}T12:00:00`)}
      agora={new Date(`${DIA}T08:00:00`)}
      fuso={Intl.DateTimeFormat().resolvedOptions().timeZone}
      pessoas={[{ id: "p1", nome: "Ana Teste", trilha: 1 }]}
      agendamentos={[COMPROMISSO]}
      interacao={{
        horariosPorDia: { [DIA]: [{ instante: `${DIA}T15:00:00.000`, rotulo: "15:00" }] },
        motivo: null,
        duracaoMin: 30,
        onMarcarEm: vi.fn(),
        onArrastarPara: vi.fn(),
      }}
    />,
  );
  return screen.getByTestId("agendamento-a1");
}

/** jsdom não traz `PointerEvent`: um MouseEvent com `pointerType` basta ao código. */
function ponteiro(tipo: string, pointerType: string, clientY: number) {
  const ev = new MouseEvent(tipo, { bubbles: true, clientX: 10, clientY, button: 0 });
  Object.assign(ev, { pointerType, pointerId: 1 });
  return ev;
}

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("arrastar consulta no toque", () => {
  it("deslizar o dedo logo de cara não propõe remarcação (é rolagem)", () => {
    const card = montar();
    fireEvent(card, ponteiro("pointerdown", "touch", 100));
    act(() => {
      window.dispatchEvent(ponteiro("pointermove", "touch", 160));
    });
    expect(screen.queryByTestId("fantasma-do-arraste")).toBeNull();
  });

  it("depois do toque longo o mesmo deslize arrasta", () => {
    const card = montar();
    fireEvent(card, ponteiro("pointerdown", "touch", 100));
    act(() => {
      vi.advanceTimersByTime(TOQUE_LONGO_MS);
      window.dispatchEvent(ponteiro("pointermove", "touch", 160));
    });
    expect(screen.getByTestId("fantasma-do-arraste")).toBeTruthy();
  });

  it("no mouse o arraste segue imediato", () => {
    const card = montar();
    fireEvent(card, ponteiro("pointerdown", "mouse", 100));
    act(() => {
      window.dispatchEvent(ponteiro("pointermove", "mouse", 160));
    });
    expect(screen.getByTestId("fantasma-do-arraste")).toBeTruthy();
    expect(card.className).not.toContain("touch-none");
  });
});
