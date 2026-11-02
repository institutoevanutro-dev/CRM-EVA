import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createApiTokenSchema } from "@/lib/schemas/team";
import { ApiTokensClient } from "./ApiTokensClient";

const create = vi.hoisted(() => vi.fn(async () => ({ data: null })));
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useApiTokensTemporarias: () => ({ data: undefined, isLoading: false, isError: false }),
  useCreateApiToken: () => ({ mutateAsync: create, isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

afterEach(cleanup);

it("oferece a permissão sensível separada e envia só os escopos escolhidos", async () => {
  render(<ApiTokensClient />);
  fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Prontuário de teste" } });
  fireEvent.click(screen.getByRole("button", { name: /^prontuario:contacts:read —/ }));
  fireEvent.click(screen.getByRole("button", { name: /^prontuario:contacts:demographics:read —/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Criar$/ }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({
    name: "Prontuário de teste", scopes: ["prontuario:contacts:read", "prontuario:contacts:demographics:read"], expires_in_days: undefined,
  }));
});

it("oferece a chave só do Financeiro e envia apenas esse escopo, por 365 dias", async () => {
  render(<ApiTokensClient />);
  fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Financeiro leitura" } });
  const opcao = screen.getByRole("button", { name: /^financeiro:contatos —/ });
  expect(opcao).toHaveAttribute("title", "Financeiro: ler nome, telefone e e-mail de um contato");
  fireEvent.click(opcao);
  fireEvent.change(screen.getByLabelText(/^Expira em/), { target: { value: "365" } });
  fireEvent.click(screen.getByRole("button", { name: /^Criar$/ }));
  await waitFor(() => expect(create).toHaveBeenLastCalledWith({
    name: "Financeiro leitura", scopes: ["financeiro:contatos"], expires_in_days: 365,
  }));
});

it("o contrato de criação aceita a chave do Financeiro do jeito que a tela a envia", () => {
  expect(createApiTokenSchema.parse({ name: "Financeiro leitura", scopes: ["financeiro:contatos"], expires_in_days: 365 }))
    .toEqual({ name: "Financeiro leitura", scopes: ["financeiro:contatos"], expires_in_days: 365 });
});

it("avisa quando um escopo de agenda é marcado sem o Operador de agenda, e o aviso some ao marcá-lo", () => {
  render(<ApiTokensClient />);
  fireEvent.click(screen.getByRole("button", { name: "Criar token" }));
  expect(screen.queryByText(/só funcionam com o escopo role:ai_operator/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^agenda:outcome —/ }));
  expect(screen.getByRole("alert")).toHaveTextContent(/role:ai_operator/);
  fireEvent.click(screen.getByRole("button", { name: /^role:ai_operator —/ }));
  expect(screen.queryByText(/só funcionam com o escopo role:ai_operator/)).toBeNull();
});
