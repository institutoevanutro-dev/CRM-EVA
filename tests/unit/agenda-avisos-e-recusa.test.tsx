/**
 * Auditoria de 17/11, lote 12 (itens 131, 137 e 138): a grade dá UM aviso,
 * impessoal e com a porta para configurar; a recusa do arraste fala simples e
 * oferece o Remarcar do próprio compromisso.
 */
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  horarios: { data: undefined as unknown, isError: true },
  interacao: undefined as undefined | { onArrastarPara?: (e: { id: string; instante: string | null; razao: string }) => void },
}));

vi.mock("@/hooks/agenda/useHorariosLivres", () => ({ useHorariosLivres: () => estado.horarios }));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/agenda/GradeDaAgenda", () => ({
  GradeDaAgenda: (p: { interacao?: typeof estado.interacao }) => {
    estado.interacao = p.interacao;
    return <div data-testid="grade" />;
  },
}));

import { AgendaInterativa } from "@/components/agenda/AgendaInterativa";
import type { Agendamento } from "@/components/agenda/tipos";

afterEach(cleanup);

const AGORA = new Date("2026-09-24T12:00:00.000Z");
const OUTRA: Agendamento = {
  id: "a1",
  titulo: "Consulta",
  responsavelId: "p2",
  tipoId: "t-outro",
  comeca: "2026-09-24T14:00:00.000Z",
  termina: "2026-09-24T14:30:00.000Z",
  origem: "ui",
  situacao: "confirmed",
};

function montar(extra: { onMarcarEm?: () => void; onRemarcar?: (id: string) => void } = {}) {
  render(
    <AgendaInterativa
      visao="dia"
      ancora={AGORA}
      agora={AGORA}
      fuso="America/Sao_Paulo"
      pessoas={[]}
      agendamentos={[OUTRA]}
      recorte={{ de: "2026-09-24", ate: "2026-09-25" }}
      tipos={[{ id: "t1", nome: "Avaliação", duracaoMin: 30 }]}
      tipo={{ id: "t1", duracaoMin: 30, donoId: "p1" }}
      onEscolherTipo={vi.fn()}
      {...extra}
    />,
  );
}

describe("aviso da grade", () => {
  it("falha: texto impessoal e porta para configurar, para quem marca", () => {
    estado.horarios = { data: undefined, isError: true };
    montar({ onMarcarEm: vi.fn() });
    const aviso = screen.getByTestId("motivo-da-grade");
    expect(aviso.textContent).toContain("Não foi possível carregar os horários.");
    expect(aviso.textContent).not.toMatch(/consegui|eu conseguir/);
    expect(screen.getByTestId("motivo-da-grade-configurar").getAttribute("href")).toBe("/app/team?aba=atendimento");
  });

  it("quem só lê não recebe a porta", () => {
    estado.horarios = { data: undefined, isError: true };
    montar();
    expect(screen.queryByTestId("motivo-da-grade-configurar")).toBeNull();
  });
});

describe("recusa do arraste", () => {
  it("compromisso de outra agenda: a recusa oferece o Remarcar dele", () => {
    estado.horarios = { data: { slots: [{ inicio: "2026-09-24T15:00:00.000Z", fim: "x" }], publicou_horarios: true }, isError: false };
    const onRemarcar = vi.fn();
    montar({ onMarcarEm: vi.fn(), onRemarcar });
    act(() => estado.interacao?.onArrastarPara?.({ id: "a1", instante: null, razao: "este horário já passou" }));
    expect(screen.getByTestId("remarcacao-recusada")).toBeTruthy();
    fireEvent.click(screen.getByTestId("remarcacao-recusada-remarcar"));
    expect(onRemarcar).toHaveBeenCalledWith("a1");
    expect(screen.queryByTestId("remarcacao-recusada")).toBeNull();
  });
});
