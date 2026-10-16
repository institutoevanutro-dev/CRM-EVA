import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ editar: vi.fn(), erro: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", role: "manager" } }),
}));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useEditarFunil: () => ({ isPending: false, mutate: mocks.editar }),
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: mocks.erro }));

import { CabecalhoDoFunil } from "./_cor";

const FUNIL = { id: "f-1", name: "Pacientes", slug: "pacientes", vocabulary: null, settings: null, color: null };

beforeEach(() => vi.clearAllMocks());

/**
 * Configurações › Funis: a cor do funil se escolhe no cabeçalho de cada funil,
 * com o mesmo seletor da etapa, e grava pela rota de funis (migration 0371).
 */
describe("a cor do funil em Configurações › Funis", () => {
  it("escolher um tom grava pelo PATCH do funil e mostra o ponto na hora", async () => {
    const user = userEvent.setup();
    render(<CabecalhoDoFunil pipeline={FUNIL} />);
    expect(screen.getByRole("heading", { name: "Pacientes" }).getAttribute("data-cor-do-funil")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cor do funil" }));
    await user.click(await screen.findByRole("button", { name: "Verde" }));

    expect(mocks.editar).toHaveBeenCalledWith({ id: "f-1", patch: { color: "#639922" } }, expect.anything());
    expect(screen.getByRole("heading", { name: "Pacientes" }).getAttribute("data-cor-do-funil")).toBe("#639922");
  });

  it("se a rota recusar, a cor volta a ser a de antes e o erro aparece", async () => {
    mocks.editar.mockImplementation((_vars, opts: { onError: (e: unknown) => void }) => opts.onError(new Error("x")));
    const user = userEvent.setup();
    render(<CabecalhoDoFunil pipeline={{ ...FUNIL, color: "#378ADD" }} />);

    await user.click(screen.getByRole("button", { name: "Cor do funil" }));
    await user.click(await screen.findByRole("button", { name: "Rosa" }));

    expect(mocks.erro).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Pacientes" }).getAttribute("data-cor-do-funil")).toBe("#378ADD");
  });
});
