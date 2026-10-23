import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

/**
 * As chaves `agent-run:` que o runtime da IA cria a cada execução não entram na
 * lista principal: viram uma linha recolhida com a contagem, e só são buscadas
 * quando alguém abre.
 */

const linha = (over: Record<string, unknown>) => ({
  id: "x", name: "x", prefix: "dsk_x", scopes: [], last_used_at: null,
  expires_at: null, revoked_at: "2026-10-20T00:00:00Z", created_at: "2026-10-20T00:00:00Z", ...over,
});

const temporarias = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/team/useApiTokens", () => ({
  useApiTokens: () => ({
    data: {
      data: [linha({ id: "p1", name: "Prontuário", prefix: "dsk_ab12cd34" })],
      meta: { temporarias_da_ia: 1410 },
    },
    isLoading: false,
    isError: false,
  }),
  useApiTokensTemporarias: (enabled: boolean) => {
    temporarias(enabled);
    return enabled
      ? { data: { data: [linha({ id: "r1", name: "agent-run:abc", prefix: "dsk_run_abc_1234" })] }, isLoading: false, isError: false }
      : { data: undefined, isLoading: false, isError: false };
  },
  useCreateApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRevokeApiToken: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApiTokensClient } from "./ApiTokensClient";

afterEach(cleanup);

it("lista só as chaves de pessoas e recolhe as temporárias da IA com a contagem", async () => {
  render(<ApiTokensClient />);

  expect(screen.getByText("Prontuário")).toBeTruthy();
  expect(screen.queryByText("agent-run:abc")).toBeNull();
  expect(temporarias).toHaveBeenLastCalledWith(false);

  const resumo = screen.getByText("Chaves temporárias da IA", { exact: false });
  expect(resumo.textContent).toContain("(1410)");

  fireEvent.click(resumo);
  await waitFor(() => expect(screen.getByText("agent-run:abc")).toBeTruthy());
  expect(temporarias).toHaveBeenLastCalledWith(true);

  // O "Revogado" da temporária é neutro; o da chave de pessoa continua vermelho.
  const [dePessoa, daIa] = screen.getAllByText("Revogado");
  expect(dePessoa?.className).not.toBe(daIa?.className);
  const linhaDaIa = screen.getByText("agent-run:abc").closest("tr")!;
  expect(within(linhaDaIa).queryByRole("button", { name: "Revogar" })).toBeNull();
});
