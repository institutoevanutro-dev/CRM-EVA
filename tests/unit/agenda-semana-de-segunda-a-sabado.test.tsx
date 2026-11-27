/**
 * Semana e mês de segunda a sábado (decisão 4 do André, 27/11/2026): o domingo
 * volta só quando tem compromisso nosso nele — ou quando é o próprio dia aberto.
 */
import { render, screen } from "@testing-library/react";
import { format } from "date-fns";
import { describe, expect, it } from "vitest";

import { GradeDaAgenda, diasDaSemanaDe } from "@/components/agenda/GradeDaAgenda";
import type { Agendamento } from "@/components/agenda/tipos";

const SP = "America/Sao_Paulo";
const QUARTA = new Date(2026, 8, 16, 12); // quarta, 16/09/2026
const chave = (d: Date) => format(d, "yyyy-MM-dd");

function noDomingo(extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id: "dom",
    titulo: "Consulta",
    responsavelId: "ana",
    comeca: "2026-09-20T10:00:00-03:00",
    termina: "2026-09-20T10:30:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...extra,
  };
}

describe("os dias da semana desenhada", () => {
  it("segunda a sábado quando ninguém marcou no domingo", () => {
    expect(diasDaSemanaDe(QUARTA, [], SP).map(chave)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
    ]);
  });

  it("o domingo entra no FIM quando tem compromisso nosso nele", () => {
    const dias = diasDaSemanaDe(QUARTA, [noDomingo()], SP).map(chave);
    expect(dias).toHaveLength(7);
    expect(dias.at(-1)).toBe("2026-09-20");
  });

  it("ocupação do Google e cancelado no domingo não trazem o domingo", () => {
    expect(diasDaSemanaDe(QUARTA, [noDomingo({ origem: "google_sync" })], SP)).toHaveLength(6);
    expect(diasDaSemanaDe(QUARTA, [noDomingo({ situacao: "cancelled" })], SP)).toHaveLength(6);
  });

  it("abrir num domingo mostra o domingo, mesmo vazio", () => {
    const dias = diasDaSemanaDe(new Date(2026, 8, 20, 12), [], SP).map(chave);
    expect(dias[0]).toBe("2026-09-14");
    expect(dias.at(-1)).toBe("2026-09-20");
  });
});

describe("a grade", () => {
  const grade = (visao: "semana" | "mes", agendamentos: Agendamento[]) =>
    render(
      <GradeDaAgenda
        visao={visao}
        ancora={QUARTA}
        agora={QUARTA}
        fuso={SP}
        pessoas={[{ id: "ana", nome: "Ana Prado", trilha: 1 }]}
        agendamentos={agendamentos}
      />,
    );

  it("semana sem domingo marcado: seis colunas", () => {
    grade("semana", []);
    expect(screen.getAllByTestId(/^coluna-dia-/)).toHaveLength(6);
  });

  it("aberta num domingo vazio: a 7ª coluna é o domingo, e é ela que fica no celular", () => {
    const DOMINGO = new Date(2026, 8, 20, 12);
    render(
      <GradeDaAgenda
        visao="semana"
        ancora={DOMINGO}
        agora={DOMINGO}
        fuso={SP}
        pessoas={[{ id: "ana", nome: "Ana Prado", trilha: 1 }]}
        agendamentos={[]}
      />,
    );
    expect(screen.getAllByTestId(/^coluna-dia-/)).toHaveLength(7);
    // Sem a regra do dia aberto, o celular (que só mostra a âncora) ficaria sem coluna.
    expect(screen.getByTestId("coluna-dia-2026-09-20").className).not.toContain("max-md:hidden");
  });

  it("mês: 6 colunas; um domingo marcado em qualquer semana devolve a 7ª ao mês inteiro", () => {
    const { unmount } = grade("mes", []);
    expect(screen.getAllByTestId(/^celula-mes-/)).toHaveLength(36);
    unmount();
    grade("mes", [noDomingo()]);
    expect(screen.getAllByTestId(/^celula-mes-/)).toHaveLength(42);
  });
});
