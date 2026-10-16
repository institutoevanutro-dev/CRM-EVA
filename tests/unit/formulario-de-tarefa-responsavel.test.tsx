/**
 * O FORMULÁRIO DE TAREFA ENVIA O RESPONSÁVEL.
 *
 * O banco sempre teve `crm_tasks.assigned_to`, mas a tela não mandava o campo:
 * toda tarefa nascia sem dono e "dar uma tarefa ao Rui" era impossível.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FormularioDeTarefa } from "@/app/app/tasks/_components/FormularioDeTarefa";
import type { Tarefa } from "@/lib/tarefas/tipos";

const ANA = "11111111-1111-4111-8111-111111111111";
const RUI = "44444444-4444-4444-8444-444444444444";
const MEMBROS = [
  { user_id: ANA, role: "admin", full_name: "Ana" },
  { user_id: RUI, role: "agent", full_name: "Rui Mota" },
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
  // Na edição o responsável só vai quando MUDOU (porte do upstream #2760): sem
  // o campo no PATCH, o banco mantém o que está gravado. Reenviar o mesmo id
  // faria a rota recusar a edição do título de uma tarefa cujo responsável
  // saiu da equipe.
  it("editando sem mexer no responsável, o campo não vai (o Rui continua gravado)", async () => {
    expect(await salvar({ tarefa: tarefa({ assigned_to: RUI }) })).not.toHaveProperty("assigned_to");
  });
  it("editando tarefa de quem saiu da equipe, o título salva sem reenviar o responsável", async () => {
    const enviado = await salvar({ tarefa: tarefa({ assigned_to: "99999999-9999-4999-8999-999999999999" }) });
    expect(enviado).toMatchObject({ title: "Ligar" });
    expect(enviado).not.toHaveProperty("assigned_to");
  });
  it("editando tarefa sem responsável, não inventa um", async () => {
    expect(await salvar({ tarefa: tarefa({ assigned_to: null }) })).not.toHaveProperty("assigned_to");
  });
  it("mostra o campo Responsável", () => {
    render(<FormularioDeTarefa aberto aoMudarAbertura={() => {}} aoSalvar={vi.fn()} membros={MEMBROS} usuarioId={ANA} />);
    expect(screen.getByLabelText("Responsável")).toBeTruthy();
  });
});
