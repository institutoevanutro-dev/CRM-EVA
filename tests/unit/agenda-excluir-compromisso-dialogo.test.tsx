/**
 * O DIÁLOGO DE EXCLUIR — motivo obrigatório, aviso de "só teste ou engano", e só
 * para quem pode (migration 0364).
 *
 * O aviso é o ponto da tela: compromisso de verdade se cancela, e o diálogo diz
 * isso com o nome do botão certo. O botão de confirmar nasce desabilitado e só
 * libera com motivo de 3+ caracteres, a mesma régua da rota e do banco.
 *
 *     npx vitest run tests/unit/agenda-excluir-compromisso-dialogo.test.tsx
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

const ID = "11111111-0000-4000-8000-000000000001";
const compromisso = {
  id: ID,
  title: "Consulta de teste",
  notes: null,
  starts_at: "2026-11-02T12:00:00Z",
  ends_at: "2026-11-02T13:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  revision: 1,
  contact_id: null,
  conversation_id: null,
  outcome_source_kind: null,
  outcome_recorded_at: null,
  excluded_at: null,
  exclusion_reason: null,
  recovery: null,
  evidence_messages: [],
};

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function abrir(podeExcluir: boolean, onClose = () => {}) {
  render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>
        <DetalheDoCompromisso id={ID} onClose={onClose} podeExcluir={podeExcluir} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

describe("excluir agendamento lançado por engano", () => {
  it("quem não é gerente nem admin não vê o botão", async () => {
    api.get.mockResolvedValue({ data: compromisso });
    abrir(false);
    await screen.findByTestId("compromisso-horario");
    expect(screen.queryByTestId("excluir-compromisso")).toBeNull();
  });

  it("o diálogo avisa que é para teste ou engano, aponta Cancelar e exige motivo", async () => {
    api.get.mockResolvedValue({ data: compromisso });
    api.post.mockResolvedValue({ data: { id: ID } });
    const onClose = vi.fn();
    abrir(true, onClose);
    fireEvent.click(await screen.findByTestId("excluir-compromisso"));

    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo.textContent).toContain("teste ou lançado por engano");
    expect(dialogo.textContent).toContain('use "Cancelar agendamento"');

    const confirmar = screen.getByTestId("confirmar-exclusao");
    expect(confirmar).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Motivo da exclusão"), { target: { value: "  x " } });
    expect(confirmar).toHaveProperty("disabled", true);
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Motivo da exclusão"), { target: { value: " teste do sistema " } });
    expect(confirmar).toHaveProperty("disabled", false);
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/api/v1/agenda/agendamentos/${ID}/excluir`, {
        reason: "teste do sistema",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("um compromisso já CANCELADO também pode ser excluído", async () => {
    api.get.mockResolvedValue({ data: { ...compromisso, status: "cancelled" } });
    abrir(true);
    expect(await screen.findByTestId("excluir-compromisso")).toBeTruthy();
  });

  it("o já excluído diz que foi excluído, com o motivo, e não oferece ação nenhuma", async () => {
    api.get.mockResolvedValue({
      data: { ...compromisso, status: "cancelled", excluded_at: "2026-10-15T12:00:00Z", exclusion_reason: "teste" },
    });
    abrir(true);
    const aviso = await screen.findByTestId("compromisso-excluido");
    expect(aviso.textContent).toContain("Excluído (lançado por engano)");
    expect(aviso.textContent).toContain("teste");
    expect(screen.queryByTestId("excluir-compromisso")).toBeNull();
    expect(screen.queryByText("Cancelar agendamento")).toBeNull();
  });
});
