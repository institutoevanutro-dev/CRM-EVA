import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ApiTokensClient } from "./ApiTokensClient";

const create = vi.hoisted(() => vi.fn(async () => ({ data: null })));
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useCreateApiToken: () => ({ mutateAsync: create, isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

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
