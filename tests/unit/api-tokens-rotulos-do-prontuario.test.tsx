import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * OS ESCOPOS DO PRONTUÁRIO NA TELA DE TOKENS.
 *
 * Os escopos `prontuario:*` e os de agenda são do mesmo módulo, e os rótulos têm
 * de chamá-lo do mesmo jeito: "Prontuário". Dois deles diziam "Prontuário" com o
 * nome de outra instalação colado atrás, na tela de quem instala. Que o nome não
 * volte a aparecer em texto, em nenhum arquivo, é a catraca de
 * `tests/unit/branding.test.ts`; este caso prova o texto exato dos dois rótulos.
 */

vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useApiTokensTemporarias: () => ({ data: undefined, isLoading: false, isError: false }),
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApiTokensClient } from "@/app/app/settings/api-tokens/_components/ApiTokensClient";

afterEach(cleanup);

describe("rótulos de escopo da tela de tokens", () => {
  it("os escopos do prontuário dizem só \"Prontuário\"", async () => {
    const user = userEvent.setup();
    render(<ApiTokensClient />);
    await user.click(screen.getByRole("button", { name: "Criar token" }));

    // O rótulo de cada escopo mora no `title` do botão dele.
    expect(screen.getByTitle("Prontuário: pesquisar cadastro de contatos")).toBeInTheDocument();
    expect(screen.getByTitle("Prontuário: criar e atualizar cadastro de contatos")).toBeInTheDocument();
    // Controle: o irmão que já dizia "Prontuário" segue igual, então o diálogo abriu mesmo.
    expect(screen.getByTitle("Prontuário: ler compromissos da agenda")).toBeInTheDocument();
  });
});
