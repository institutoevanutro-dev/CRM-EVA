/**
 * O DOSSIÊ ABERTO NÃO DESFAZ O QUE A IA OU UM COLEGA GRAVOU (auditoria L4, achado 6).
 *
 * O formulário mandava TODOS os campos de cima a cada Salvar, com o valor de
 * quando abriu. Aqui roda o componente de verdade: o lead muda "por fora"
 * (como o realtime entrega a gravação da IA) com o dossiê aberto, a pessoa
 * mexe em OUTRO campo e salva — e o patch tem de levar só o que ela mexeu.
 *
 * O último caso são duas gravações concorrentes de verdade: dois dossiês
 * abertos no mesmo lead, cada um mexe num campo, os dois salvam, e um
 * "servidor" que aplica patch campo a campo (como o PATCH + `fn_lead_anotar_campos`)
 * termina com as DUAS mudanças. Nomes fictícios.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Lead } from "@/lib/types/leads";

const mutateAsync = vi.fn(async (_: unknown) => ({}));

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org-1" }) }));
// As vendas registradas do negócio (porte do original #5087): sem venda, o
// Valor segue editável como antes.
vi.mock("@/hooks/vendas/useVendasRegistradas", () => ({
  useVendasDoNegocio: () => ({ data: [] }),
  useRegistrarVenda: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useApagarVenda: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: ["vip", "retorno"] }),
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useEditLead: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/components/kanban/EcoDoValor", () => ({ EcoDoValor: () => null }));

import { LeadFieldsForm } from "@/components/kanban/LeadFieldsForm";

const V1 = {
  id: "lead-6",
  title: "Avaliação Bruna Teixeira",
  description: "Primeiro contato",
  value_cents: 50000,
  currency: "BRL",
  tags: ["retorno"],
  expected_close_date: null,
  custom_fields: { convenio: "Particular", queixa: "cansaço" },
} as unknown as Lead;

const CAMPOS = [
  { key: "convenio", label: "Convênio", type: "text" as const },
  { key: "queixa", label: "Queixa", type: "text" as const },
];

type Patch = Record<string, unknown>;
const patchDa = (i: number) => (mutateAsync.mock.calls[i]![0] as { patch: Patch }).patch;

describe("dossiê do lead com gravação por fora (achado 6)", () => {
  it("a IA grava descrição, valor, etiqueta e um campo; a pessoa salva o título — nada da IA volta", async () => {
    mutateAsync.mockClear();
    const { rerender } = render(<LeadFieldsForm lead={V1} pipelineId="p" fieldDefs={CAMPOS} />);

    // A pessoa começa a editar o título...
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Avaliação Bruna T." } });

    // ...e o realtime entrega o que a IA gravou nesse meio-tempo.
    const V2 = {
      ...V1,
      description: "Quer agendar na terça",
      value_cents: 80000,
      tags: ["retorno", "vip"],
      custom_fields: { convenio: "Unimed", queixa: "cansaço" },
    } as unknown as Lead;
    rerender(<LeadFieldsForm lead={V2} pipelineId="p" fieldDefs={CAMPOS} />);

    // A tela mostra o valor novo nos campos que a pessoa não mexeu...
    expect(screen.getByLabelText("Descrição")).toHaveValue("Quer agendar na terça");
    expect(screen.getByLabelText("Convênio")).toHaveValue("Unimed");
    expect(screen.getByText("vip")).toBeInTheDocument();
    // ...e não atropela o que ela está digitando.
    expect(screen.getByLabelText("Título")).toHaveValue("Avaliação Bruna T.");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(patchDa(0)).toEqual({ title: "Avaliação Bruna T." });
  });

  it("tirar uma etiqueta enquanto a IA põe outra: as duas mudanças valem", async () => {
    mutateAsync.mockClear();
    const { rerender } = render(<LeadFieldsForm lead={V1} pipelineId="p" fieldDefs={CAMPOS} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover etiqueta retorno" }));
    rerender(
      <LeadFieldsForm lead={{ ...V1, tags: ["retorno", "vip"] } as Lead} pipelineId="p" fieldDefs={CAMPOS} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(patchDa(0)).toEqual({ tags: ["vip"] });
  });

  it("duas gravações concorrentes em campos diferentes: as duas ficam", async () => {
    mutateAsync.mockClear();
    // O "servidor": coluna por coluna, e `custom_fields` mesclado por chave —
    // o contrato do PATCH /leads/[id] com `fn_lead_anotar_campos`.
    let gravado: Patch = { ...V1, custom_fields: { ...V1.custom_fields } };
    const aplicar = (p: Patch) => {
      const { custom_fields, ...resto } = p;
      gravado = {
        ...gravado,
        ...resto,
        custom_fields: { ...(gravado.custom_fields as Patch), ...((custom_fields as Patch) ?? {}) },
      };
    };

    // Dois dossiês abertos no MESMO lead, com o mesmo retrato.
    render(
      <>
        <div data-testid="a"><LeadFieldsForm lead={V1} pipelineId="p" fieldDefs={CAMPOS} /></div>
      </>,
    );
    const a = screen.getByTestId("a");
    fireEvent.change(a.querySelector("#title")!, { target: { value: "Avaliação — Bruna" } });
    fireEvent.click(a.querySelector("button[type=submit]")!);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    aplicar(patchDa(0));

    const { container: b } = render(<LeadFieldsForm lead={V1} pipelineId="p" fieldDefs={CAMPOS} />);
    // B ainda vê o retrato velho (sem o título de A) e mexe só na queixa.
    const queixaB = b.querySelectorAll("input");
    const campoQueixa = Array.from(queixaB).find((el) => (el as HTMLInputElement).value === "cansaço")!;
    fireEvent.change(campoQueixa, { target: { value: "insônia" } });
    fireEvent.click(b.querySelector("button[type=submit]")!);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    aplicar(patchDa(1));

    expect(gravado.title).toBe("Avaliação — Bruna");
    expect(gravado.custom_fields).toEqual({ convenio: "Particular", queixa: "insônia" });
    expect(gravado.description).toBe("Primeiro contato");
  });
});
