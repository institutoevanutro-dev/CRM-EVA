/**
 * A AGENDA TEM DE MOSTRAR A AGENDA.
 *
 * O seletor de tipo de atendimento era sempre uma fileira de botões. Numa
 * clínica com 21 tipos, medido em 2026-09-24, essa fileira ocupava 134px em
 * quatro linhas e empurrava a GRADE — o conteúdo da tela — para 76% da altura:
 * quem abria a agenda via cabeçalho, avisos e etiquetas, e precisava rolar para
 * ver o dia.
 *
 * A regra vigiada aqui é a TROCA DE FORMA, não a aparência: até um punhado de
 * tipos os botões continuam (todas as opções visíveis, um clique cada), e acima
 * disso vira lista fechada, que cabe em uma linha.
 *
 * As duas pontas estão no teste de propósito. Só a de cima deixaria alguém
 * "arrumar" a tela trocando tudo por lista e piorando o caso comum, que é a
 * clínica com três tipos.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: () => ({ data: { slots: [] }, isError: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("./GradeDaAgenda", () => ({ GradeDaAgenda: () => <div data-testid="grade" /> }));

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";

const AGORA = new Date("2026-09-24T12:00:00.000Z");

function tiposFalsos(quantos: number) {
  return Array.from({ length: quantos }, (_, i) => ({
    id: `t${i}`,
    nome: `Atendimento ${i}`,
    duracaoMin: 30,
  }));
}

function montar(quantos: number) {
  const tipos = tiposFalsos(quantos);
  render(
    <AgendaInterativa
      visao="semana"
      ancora={AGORA}
      agora={AGORA}
      pessoas={[]}
      agendamentos={[]}
      recorte={{ de: "2026-09-20", ate: "2026-09-26" }}
      tipos={tipos}
      tipo={{ id: tipos[0]!.id, duracaoMin: 30 }}
      onEscolherTipo={vi.fn()}
      onMarcarEm={vi.fn()}
    />,
  );
}

describe("agenda — muitos tipos viram lista", () => {
  it("com 3 tipos, continuam botões — todas as opções visíveis de relance", () => {
    montar(3);
    expect(screen.queryByTestId("tipo-da-grade-lista")).toBeNull();
    expect(screen.getByTestId("tipo-da-grade").querySelectorAll("button")).toHaveLength(3);
  });

  it("com 6 tipos ainda são botões — seis cabem numa linha", () => {
    montar(6);
    expect(screen.queryByTestId("tipo-da-grade-lista")).toBeNull();
  });

  /** O caso medido na clínica: 21 tipos, quatro linhas, a grade fora da tela. */
  it("com 21 tipos vira lista fechada, e nenhum botão de tipo sobra", () => {
    montar(21);
    const lista = screen.getByTestId("tipo-da-grade-lista");
    expect(lista.querySelectorAll("option")).toHaveLength(21);
    expect(screen.getByTestId("tipo-da-grade").querySelectorAll("button")).toHaveLength(0);
  });

  it("a lista mantém rótulo acessível — trocar o tipo por teclado continua possível", () => {
    montar(21);
    expect(
      screen.getByLabelText("Tipo de atendimento dos horários livres"),
    ).toBeTruthy();
  });
});
