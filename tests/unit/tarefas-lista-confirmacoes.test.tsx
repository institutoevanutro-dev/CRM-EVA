/**
 * Lote 19, itens 190, 191 e 194: o "Confirmar" de apagar desarma, a falha
 * aparece na linha, e reabrir uma concluída de prazo vencido avisa do bônus.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListaDeTarefas, reabrirMudaOBonus } from "@/app/app/tasks/_components/ListaDeTarefas";
import type { Tarefa } from "@/lib/tarefas/tipos";

function tarefa(resto: Partial<Tarefa> = {}): Tarefa {
  return {
    id: "t-1",
    organization_id: "org-1",
    title: "Ligar para confirmar o retorno",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: null,
    contact_id: null,
    assigned_to: null,
    created_by: "u-1",
    created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-01T12:00:00Z",
    ...resto,
  };
}

const base = { podeEditar: true, aoEditar: vi.fn(), nomeDoResponsavel: () => null, mostrarNegocio: false };

afterEach(() => vi.useRealTimers());

describe("ListaDeTarefas — confirmações e falhas", () => {
  it("o Confirmar de apagar desarma sozinho depois de alguns segundos (190)", () => {
    vi.useFakeTimers();
    render(<ListaDeTarefas {...base} tarefas={[tarefa()]} aoAlternarConcluida={vi.fn()} aoApagar={vi.fn()} />);
    act(() => screen.getByRole("button", { name: "Apagar a tarefa" }).click());
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryByRole("button", { name: "Confirmar" })).not.toBeInTheDocument();
  });

  it("se concluir falhar, a linha diz o que houve (191)", async () => {
    const falha = vi.fn(async () => {
      throw new Error("Não foi possível salvar a tarefa.");
    });
    render(<ListaDeTarefas {...base} tarefas={[tarefa()]} aoAlternarConcluida={falha} aoApagar={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Marcar como concluída" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar a tarefa.");
  });

  it("reabrir uma concluída de prazo vencido pede confirmação e avisa do bônus (194)", async () => {
    const alternar = vi.fn(async () => ({}));
    const feita = tarefa({ status: "done", due_date: "2026-01-10T12:00:00Z" });
    render(<ListaDeTarefas {...base} tarefas={[feita]} aoAlternarConcluida={alternar} aoApagar={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Reabrir a tarefa" }));
    expect(alternar).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/atrasada no bônus/);
    await userEvent.click(screen.getByRole("button", { name: "Reabrir mesmo assim" }));
    expect(alternar).toHaveBeenCalledWith(feita);
  });

  it("só a concluída com prazo vencido muda o bônus", () => {
    const agora = new Date("2026-11-19T12:00:00Z");
    expect(reabrirMudaOBonus(tarefa({ status: "done", due_date: "2026-11-01T12:00:00Z" }), agora)).toBe(true);
    expect(reabrirMudaOBonus(tarefa({ status: "done", due_date: "2026-12-01T12:00:00Z" }), agora)).toBe(false);
    expect(reabrirMudaOBonus(tarefa({ status: "done", due_date: null }), agora)).toBe(false);
    expect(reabrirMudaOBonus(tarefa({ status: "pending", due_date: "2026-11-01T12:00:00Z" }), agora)).toBe(false);
  });
});

describe("CalendarioDeTarefas — item 193", () => {
  const hoje = new Date();
  hoje.setHours(12, 0, 0, 0);
  const doDia = Array.from({ length: 5 }, (_, i) =>
    tarefa({ id: `t-${i}`, title: `Tarefa ${i}`, due_date: hoje.toISOString() }),
  );
  const props = { tarefas: doDia, aoAbrirTarefa: vi.fn(), aoClicarNoDia: vi.fn(), nomeDoResponsavel: () => null };

  it("quem só lê não abre a edição; o +N mais abre o dia inteiro", async () => {
    const { CalendarioDeTarefas } = await import("@/app/app/tasks/_components/CalendarioDeTarefas");
    render(<CalendarioDeTarefas {...props} podeEditar={false} />);
    expect(screen.queryByRole("button", { name: "Tarefa 0" })).not.toBeInTheDocument();
    expect(screen.getByText("Tarefa 0")).toBeInTheDocument();
    expect(screen.queryByText("Tarefa 4")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /\+2 mais/ }));
    expect(screen.getByText("Tarefa 4")).toBeInTheDocument();
  });

  it("quem edita cria pelo número do dia, que é um botão", async () => {
    const { CalendarioDeTarefas } = await import("@/app/app/tasks/_components/CalendarioDeTarefas");
    const aoClicarNoDia = vi.fn();
    render(<CalendarioDeTarefas {...props} aoClicarNoDia={aoClicarNoDia} podeEditar />);
    await userEvent.click(screen.getAllByRole("button", { name: /^Nova tarefa em / })[0]!);
    expect(aoClicarNoDia).toHaveBeenCalledTimes(1);
  });
});
