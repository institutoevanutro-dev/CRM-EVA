/**
 * O "quando" da marcação (decisão 1 do André, 27/11/2026): campo de hora com
 * relógio e os horários livres embaixo como atalho. Clicar num horário preenche
 * o campo; digitar uma hora da lista escolhe aquele horário; digitar uma hora de
 * fora vale como encaixe (para quem pode) e avisa "Fora dos horários livres".
 *
 * Nomes e datas fictícios.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { QuandoDaMarcacao } from "@/components/agenda/QuandoDaMarcacao";
import type { HorarioLivre } from "@/components/agenda/tipos";

afterEach(cleanup);

const DIA = new Date(2026, 9, 22, 12);
/** 13:00 e 14:00 em São Paulo (UTC-3). */
const H13: HorarioLivre = { instante: "2026-10-22T16:00:00.000Z", rotulo: "13:00" };
const H14: HorarioLivre = { instante: "2026-10-22T17:00:00.000Z", rotulo: "14:00" };

function Montar({
  aoEscolher,
  ...props
}: Partial<ComponentProps<typeof QuandoDaMarcacao>> & { aoEscolher?: (h: HorarioLivre | null) => void }) {
  const [dia, setDia] = useState(DIA);
  const [horario, setHorario] = useState<HorarioLivre | null>(null);
  return (
    <>
      <QuandoDaMarcacao
        ancora={DIA}
        agora={new Date(2026, 9, 22, 8)}
        fuso="America/Sao_Paulo"
        horariosPorDia={{ "2026-10-22": [H13, H14], "2026-10-23": [H13] }}
        publicouHorarios
        erroAoCarregar={false}
        fusoSuposto={false}
        onMesVisivel={vi.fn()}
        mesCarregado={new Date(2026, 9, 1)}
        temTipo
        avisoSemTipo="Escolha o profissional e o procedimento para ver os horários livres."
        permiteEncaixe
        abriuComHorario={false}
        dia={dia}
        onDia={setDia}
        horario={horario}
        onHorario={(h) => {
          setHorario(h);
          aoEscolher?.(h);
        }}
        {...props}
      />
      <button type="button" onClick={() => setHorario(null)}>
        limpar por fora
      </button>
    </>
  );
}

const campo = () => screen.getByTestId("hora-da-marcacao") as HTMLInputElement;

describe("o quando da marcação", () => {
  it("clicar num horário livre preenche o campo de hora, sem aviso", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    expect(campo()).toHaveAttribute("type", "time");
    expect(campo()).toHaveAttribute("step", "300");
    fireEvent.click(screen.getByTestId("horario-13:00"));
    expect(campo().value).toBe("13:00");
    expect(aoEscolher).toHaveBeenLastCalledWith(H13);
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("digitar uma hora da lista escolhe aquele mesmo horário", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    fireEvent.change(campo(), { target: { value: "14:00" } });
    expect(aoEscolher).toHaveBeenLastCalledWith(H14);
    expect(screen.getByTestId("horario-14:00")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("hora fora da lista vale como encaixe e avisa", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    expect(aoEscolher).toHaveBeenLastCalledWith({ instante: "2026-10-22T13:30:00.000Z", rotulo: "10:30" });
    expect(screen.getByTestId("fora-dos-horarios-livres")).toHaveTextContent("Fora dos horários livres");
  });

  it("sem encaixe, a hora de fora não vira horário — o aviso fica", () => {
    const aoEscolher = vi.fn();
    render(<Montar aoEscolher={aoEscolher} permiteEncaixe={false} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    expect(aoEscolher).toHaveBeenLastCalledWith(null);
    expect(campo().value).toBe("10:30");
    expect(screen.getByTestId("fora-dos-horarios-livres")).toBeInTheDocument();
  });

  it("quem chama limpa o horário (trocou o profissional): o campo esvazia", () => {
    render(<Montar />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    fireEvent.click(screen.getByText("limpar por fora"));
    expect(campo().value).toBe("");
  });

  it("trocar de dia limpa a hora, mesmo a digitada e não aplicada", () => {
    render(<Montar permiteEncaixe={false} />);
    fireEvent.change(campo(), { target: { value: "10:30" } });
    fireEvent.click(screen.getByTestId("dia-2026-10-23"));
    expect(campo().value).toBe("");
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();
  });

  it("sem procedimento o campo fica desligado e a tela diz por quê", () => {
    render(<Montar temTipo={false} />);
    expect(campo()).toBeDisabled();
    expect(screen.getByText("Escolha o profissional e o procedimento para ver os horários livres.")).toBeInTheDocument();
  });
});
