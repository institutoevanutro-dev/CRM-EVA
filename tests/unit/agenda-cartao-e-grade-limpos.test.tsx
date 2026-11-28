/** O visual da grade (decisão 7 do André, 27/11/2026). Nomes fictícios. */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";

function grade(agendamentos: Agendamento[] = []) {
  return render(
    <GradeDaAgenda
      visao="dia"
      ancora={new Date(2026, 8, 16, 12)}
      agora={new Date("2026-09-16T06:00:00-03:00")}
      fuso="America/Sao_Paulo"
      pessoas={[{ id: "ana", nome: "Ana Prado", trilha: 1 }]}
      agendamentos={agendamentos}
    />,
  );
}

const consulta = (duracaoMin: number): Agendamento => ({
  id: "a",
  titulo: "Consulta",
  quemSeraAtendido: "Marina Alves",
  responsavelId: "ana",
  comeca: "2026-09-16T10:00:00-03:00",
  termina: new Date(Date.parse("2026-09-16T10:00:00-03:00") + duracaoMin * 60_000).toISOString(),
  origem: "ui",
  situacao: "pending",
});

describe("grade mais limpa", () => {
  it("a coluna de horas mostra só as horas cheias", () => {
    grade();
    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.queryByText("09:30")).toBeNull();
  });

  it("a meia hora segue marcada: uma linha pontilhada por hora desenhada no dia", () => {
    grade();
    const corpo = screen.getByTestId("coluna-dia-2026-09-16").querySelector("[data-corpo-do-dia]")!;
    // Janela padrão 07h–21h: 15 horas, 15 linhas de meia hora.
    expect(corpo.querySelectorAll(".border-dotted")).toHaveLength(15);
  });

  it("o estado vai para o canto; o nome fica sozinho na linha 1 e a hora com o procedimento embaixo", () => {
    grade([consulta(60)]);
    expect(within(screen.getByTestId("cantos-a")).getByTestId("situacao-a")).toBeInTheDocument();
    const cartao = screen.getByTestId("agendamento-a");
    expect(cartao).toHaveTextContent("Marina Alves");
    expect(cartao).toHaveTextContent("10:00 · Consulta");
  });

  it("cartão curto (30 min) é uma linha só: hora e nome", () => {
    grade([consulta(30)]);
    expect(screen.getByTestId("agendamento-a")).toHaveTextContent("10:00 Marina Alves");
    expect(screen.getByTestId("agendamento-a")).not.toHaveTextContent("· Consulta");
  });

  it("o corte é a altura desenhada: 38 min ainda é uma linha, 39 min já são duas", () => {
    const { unmount } = grade([consulta(38)]);
    expect(screen.getByTestId("agendamento-a")).not.toHaveTextContent("· Consulta");
    unmount();
    grade([consulta(39)]);
    expect(screen.getByTestId("agendamento-a")).toHaveTextContent("10:00 · Consulta");
  });

  it("card recortado no topo da janela conta só o pedaço desenhado", () => {
    // Ocupação do Google não alarga a janela (07h): das 06:00 às 07:20, só 20
    // min aparecem — uma linha, embora a duração inteira tenha 80 min.
    grade([
      {
        id: "g",
        titulo: "Ocupado",
        responsavelId: "ana",
        comeca: "2026-09-16T06:00:00-03:00",
        termina: "2026-09-16T07:20:00-03:00",
        origem: "google_sync",
        situacao: "confirmed",
      },
    ]);
    const cartao = screen.getByTestId("agendamento-g");
    expect(cartao.style.top).toBe("0px");
    expect(cartao).toHaveTextContent("06:00 Ocupado");
  });
});
