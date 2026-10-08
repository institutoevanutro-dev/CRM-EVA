/**
 * SALVAR A FICHA DO NEGÓCIO NÃO DESFAZ O QUE OUTRO ACABOU DE GRAVAR.
 *
 * A ficha (`LeadFieldsForm`) guardava os campos do funil carregados ao abrir e
 * reenviava o objeto INTEIRO a cada salvamento. O servidor soma o que chega com
 * o que está gravado (desde o PR 114, numa instrução só, por
 * `fn_lead_anotar_campos`) — então a chave que a pessoa nem tocou viajava com o
 * valor VELHO e apagava o que a IA ou um colega tinha acabado de gravar.
 *
 * Aqui roda o componente de verdade e se lê o patch que ele entrega ao hook.
 * Porte do original 4bf4202ca (webtecnica).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Lead } from "@/lib/types/leads";

const mutateAsync = vi.fn(async (_: unknown) => ({}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/components/kanban/EcoDoValor", () => ({ EcoDoValor: () => null }));

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";

const LEAD = {
  id: "lead-1",
  title: "Consulta Ana",
  description: null,
  value_cents: null,
  currency: "BRL",
  tags: [],
  expected_close_date: null,
  custom_fields: { convenio: "Unimed", queixa: "dor lombar" },
} as unknown as Lead;

const CAMPOS = [
  { key: "convenio", label: "Convênio", type: "text" as const },
  { key: "queixa", label: "Queixa", type: "text" as const },
];

function patchEnviado(): Record<string, unknown> {
  const arg = mutateAsync.mock.calls.at(-1)?.[0] as { patch: Record<string, unknown> };
  return arg.patch;
}

describe("ficha do negócio: custom_fields vai só com o que a pessoa mudou", () => {
  it("mudar a queixa NÃO reenvia o convênio carregado ao abrir", async () => {
    mutateAsync.mockClear();
    render(<LeadFieldsForm lead={LEAD} pipelineId="p-1" fieldDefs={CAMPOS} />);
    fireEvent.change(screen.getByLabelText("Queixa"), { target: { value: "dor no joelho" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(patchEnviado().custom_fields).toEqual({ queixa: "dor no joelho" });
  });

  it("salvar sem mexer nos campos do funil não sobrescreve nenhum", async () => {
    mutateAsync.mockClear();
    render(<LeadFieldsForm lead={LEAD} pipelineId="p-1" fieldDefs={CAMPOS} />);
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(patchEnviado().custom_fields ?? {}).toEqual({});
  });

  it("limpar um campo preenchido chega ao servidor como string vazia", async () => {
    mutateAsync.mockClear();
    render(<LeadFieldsForm lead={LEAD} pipelineId="p-1" fieldDefs={CAMPOS} />);
    fireEvent.change(screen.getByLabelText("Convênio"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(patchEnviado().custom_fields).toEqual({ convenio: "" });
  });
});
