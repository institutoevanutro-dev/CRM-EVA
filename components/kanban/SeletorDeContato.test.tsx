/**
 * As três props opcionais do seletor (rótulo, sem "Criar contato", só listar
 * com busca). Sem elas o comportamento é o do "Novo Lead", coberto em
 * `tests/unit/novo-lead-escolhe-contato.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Contact } from "@/lib/types/contacts";

const busca = vi.fn();
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: (filtros: unknown, opcoes?: unknown) => busca(filtros, opcoes),
}));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));

import { SeletorDeContato } from "./SeletorDeContato";

const MICHELLE = {
  id: "22222222-2222-4222-8222-222222222222",
  display_name: "Michelle",
  name: null,
  phone_number: "5511988887777",
  is_anonymized: false,
  tags: [],
} as unknown as Contact;

beforeEach(() => {
  busca.mockReset();
  busca.mockReturnValue({ data: { pages: [{ data: [MICHELLE] }] }, isLoading: false });
});

describe("SeletorDeContato", () => {
  it("por padrão: rótulo Contato, lista aberta sem termo e botão de criar", () => {
    render(<SeletorDeContato escolhido={null} onEscolher={() => {}} />);
    expect(screen.getByLabelText("Contato")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Michelle/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar contato" })).toBeInTheDocument();
    // Sem opções, a consulta roda como sempre rodou.
    expect(busca.mock.calls[0]?.[1]?.enabled).not.toBe(false);
  });

  it("semCriar: o botão de criar contato não aparece", () => {
    render(<SeletorDeContato escolhido={null} onEscolher={() => {}} semCriar />);
    expect(screen.queryByRole("button", { name: "Criar contato" })).not.toBeInTheDocument();
  });

  it("soComBusca: sem termo não lista e não busca; com termo, lista", async () => {
    render(<SeletorDeContato escolhido={null} onEscolher={() => {}} soComBusca />);
    expect(screen.queryByRole("button", { name: /Michelle/ })).not.toBeInTheDocument();
    expect(busca.mock.calls.every(([, opcoes]) => opcoes?.enabled === false)).toBe(true);

    fireEvent.change(screen.getByLabelText("Contato"), { target: { value: "Mich" } });
    expect(await screen.findByRole("button", { name: /Michelle/ })).toBeInTheDocument();
    expect(busca).toHaveBeenLastCalledWith({ search: "Mich" }, { enabled: true });
  });

  it("rotulo: troca o rótulo do campo, com e sem contato escolhido", () => {
    const { rerender } = render(
      <SeletorDeContato escolhido={null} onEscolher={() => {}} rotulo="Testar como um contato (opcional)" />,
    );
    expect(screen.getByLabelText("Testar como um contato (opcional)")).toBeInTheDocument();
    rerender(
      <SeletorDeContato escolhido={MICHELLE} onEscolher={() => {}} rotulo="Testar como um contato (opcional)" />,
    );
    expect(screen.getByText("Testar como um contato (opcional)")).toBeInTheDocument();
    expect(screen.queryByText("Contato")).not.toBeInTheDocument();
  });
});
