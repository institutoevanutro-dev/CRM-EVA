/**
 * O FORMULÁRIO DE TAREFA ENVIA O RESPONSÁVEL.
 *
 * O banco sempre teve `crm_tasks.assigned_to`, mas a tela não mandava o campo:
 * toda tarefa nascia sem dono e "dar uma tarefa ao Erick" era impossível.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import type { Tarefa } from "@/lib/tarefas/tipos";

const ANA = "11111111-1111-4111-8111-111111111111";
const ERICK = "44444444-4444-4444-8444-444444444444";
const MEMBROS = [
  { user_id: ANA, role: "admin", full_name: "Ana" },
  { user_id: ERICK, role: "agent", full_name: "Erick Augusto" },
];

function tarefa(over: Partial<Tarefa>): Tarefa {
  return {
    id: "t1", organization_id: "org", title: "Ligar", description: null, due_date: null,
    priority: "medium", status: "pending", lead_id: null, contact_id: null,
    assigned_to: null, created_by: ANA, created_at: "", updated_at: "",
    ...over,
  } as Tarefa;
}

async function salvar(props: Partial<Parameters<typeof FormularioDeTarefa>[0]>) {
  const aoSalvar = vi.fn(async () => undefined);
  render(
    <FormularioDeTarefa aberto aoMudarAbertura={() => {}} aoSalvar={aoSalvar} membros={MEMBROS} usuarioId={ANA} {...props} />,
  );
  const titulo = screen.getByLabelText("O que precisa ser feito");
  if (!(titulo as HTMLInputElement).value) fireEvent.change(titulo, { target: { value: "Ligar para a paciente" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
  await waitFor(() => expect(aoSalvar).toHaveBeenCalled());
  return (aoSalvar.mock.calls[0] as unknown as [Record<string, unknown>])[0];
}

describe("FormularioDeTarefa — responsável", () => {
  it("tarefa nova nasce de quem cria", async () => {
    expect((await salvar({})).assigned_to).toBe(ANA);
  });
  it("editando, mantém o responsável gravado (o Erick)", async () => {
    expect((await salvar({ tarefa: tarefa({ assigned_to: ERICK }) })).assigned_to).toBe(ERICK);
  });
  it("editando tarefa sem responsável, não inventa um", async () => {
    expect((await salvar({ tarefa: tarefa({ assigned_to: null }) })).assigned_to).toBeNull();
  });
  it("mostra o campo Responsável", () => {
    render(<FormularioDeTarefa aberto aoMudarAbertura={() => {}} aoSalvar={vi.fn()} membros={MEMBROS} usuarioId={ANA} />);
    expect(screen.getByLabelText("Responsável")).toBeTruthy();
  });
});
