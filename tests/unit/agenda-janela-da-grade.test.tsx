/**
 * Achado 20 da auditoria de 16/11: com a janela 07–21 fixa, o compromisso das
 * 06:00 ficava acima da área desenhada, sob o cabeçalho, e o das 22:00 aparecia
 * sem rótulo de hora. A janela agora cresce até o que está marcado no período.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { GradeDaAgenda, janelaDoPeriodo } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";

afterEach(cleanup);

const FUSO = "America/Sao_Paulo";
const DIA = "2030-01-16";
function ag(id: string, de: string, ate: string, situacao: Agendamento["situacao"] = "confirmed"): Agendamento {
  return {
    id,
    titulo: "Consulta",
    responsavelId: "p1",
    comeca: `${DIA}T${de}:00-03:00`,
    termina: `${DIA}T${ate}:00-03:00`,
    origem: "ui",
    situacao,
  };
}

describe("janelaDoPeriodo", () => {
  it("sem nada marcado fora do padrão, é o dia de trabalho de sempre", () => {
    expect(janelaDoPeriodo([], FUSO)).toEqual({ primeira: 7, ultima: 21 });
    expect(janelaDoPeriodo([ag("a", "09:00", "10:00")], FUSO)).toEqual({ primeira: 7, ultima: 21 });
  });

  it("cresce para o compromisso das 06:00 e para o das 22:00", () => {
    expect(janelaDoPeriodo([ag("cedo", "06:00", "06:30"), ag("tarde", "22:00", "23:00")], FUSO)).toEqual({
      primeira: 6,
      ultima: 22,
    });
  });

  it("cancelado não alarga", () => {
    expect(janelaDoPeriodo([ag("x", "05:00", "05:30", "cancelled")], FUSO)).toEqual({ primeira: 7, ultima: 21 });
  });
});

describe("a grade desenha a hora que cresceu", () => {
  it("o compromisso das 06:00 fica no topo da área, e há rótulo de 06h e de 22h", () => {
    const { container } = render(
      <GradeDaAgenda
        visao="dia"
        ancora={new Date(`${DIA}T12:00:00`)}
        agora={new Date(`${DIA}T05:00:00-03:00`)}
        fuso={FUSO}
        pessoas={[{ id: "p1", nome: "Ana", trilha: 1 }]}
        agendamentos={[ag("cedo", "06:00", "06:30"), ag("tarde", "22:00", "22:30")]}
      />,
    );
    expect(screen.getByTestId("agendamento-cedo").style.top).toBe("0px");
    expect(container.textContent).toContain("06h");
    expect(container.textContent).toContain("22h");
  });
});

describe("a janela não pula com o filtro de pessoas (item 136, 17/11)", () => {
  it("o compromisso escondido pelo filtro ainda segura a janela", () => {
    const { container } = render(
      <GradeDaAgenda
        visao="dia"
        ancora={new Date(`${DIA}T12:00:00`)}
        agora={new Date(`${DIA}T05:00:00-03:00`)}
        fuso={FUSO}
        pessoas={[{ id: "p1", nome: "Ana", trilha: 1 }]}
        agendamentos={[ag("dela", "10:00", "10:30")]}
        janelaSobre={[ag("dela", "10:00", "10:30"), { ...ag("outra", "06:00", "06:30"), responsavelId: "p2" }]}
      />,
    );
    expect(container.textContent).toContain("06h");
  });
});
