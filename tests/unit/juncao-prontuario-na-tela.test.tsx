/**
 * Juntar fichas quando a que FICA está ligada ao prontuário: a tela mostra o
 * aviso, exige "São a mesma pessoa" para habilitar "Juntar contatos" e manda
 * `confirmar_ficha_do_prontuario: true`. Se o servidor responder o 409
 * `prontuario_confirmar_juncao` (dados velhos, ou o grupo forte, que não sabe
 * do vínculo), a confirmação reabre com o aviso e a caixa.
 *
 * Sem isto, a recepção junta a ficha da irmã dentro da ficha da paciente e os
 * exames da irmã passam a aparecer no prontuário da paciente. Nomes fictícios.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ApiError } from "@/lib/api/types";
import type { FichaParaComparar } from "@/lib/contacts/juncao";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));
const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: (e: unknown) => showApiErrorMock(e) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ role: "manager" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PACIENTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IRMA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function ficha(id: string, nome: string, prontuario_linked: boolean): FichaParaComparar {
  return {
    id,
    name: nome,
    display_name: null,
    phone_number: null,
    email: null,
    birthdate: null,
    cpf_available: false,
    endereco: null,
    prontuario_linked,
    is_blocked: false,
    force_human: false,
    ai_opt_out: false,
    inbox_hidden_at: null,
    source: null,
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: null,
    conversas: 0,
    negocios: 0,
  };
}

const contato = (id: string, nome: string) => ({
  id,
  name: nome,
  display_name: null,
  email: null,
  phone_number: null,
  created_at: "2026-01-01T00:00:00Z",
  last_activity_at: null,
});

const RESULTADO = { data: { contato_id: PACIENTE, contatos_mesclados: [IRMA], repontado: {}, nao_repontado: {}, atividades_emitidas: 0 } };
const AVISO = /Esta ficha está ligada a um paciente no Prontuário/;
const conflito409 = () =>
  new ApiError(409, "prontuario_confirmar_juncao", undefined, "req-1", "Esta ficha está ligada a um paciente no Prontuário.");

function comProvider(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** A confirmação aberta (AlertDialog). */
const confirmacao = () => within(screen.getByRole("alertdialog"));
const botaoJuntarContatos = () => confirmacao().getByRole("button", { name: "Juntar contatos" });

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  showApiErrorMock.mockReset();
});
afterEach(() => cleanup());

describe("MergeDialog: par parecido em que quem fica está no prontuário", () => {
  it("mostra o aviso, exige a caixa e envia o campo", async () => {
    // Sabotagem: sem `ficaNoProntuario` na confirmação, o botão nasce habilitado e o campo não vai.
    getMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/v1/contacts/duplicates")) {
        return {
          data: [{ chave: "p1", motivos: ["nome_parecido"], principal_sugerido: IRMA, contatos: [contato(PACIENTE, "Ana Teste"), contato(IRMA, "Bia Teste")] }],
        };
      }
      return { data: { contatos: [ficha(PACIENTE, "Ana Teste", true), ficha(IRMA, "Bia Teste", false)] } };
    });
    postMock.mockResolvedValue(RESULTADO);
    const { MergeDialog } = await import("@/components/contacts/MergeDialog");
    comProvider(<MergeDialog open onOpenChange={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Comparar" }));
    const juntar = await screen.findByRole("button", { name: "Juntar" });
    await waitFor(() => expect(juntar).toBeEnabled());
    fireEvent.click(juntar);

    expect(confirmacao().getByText(AVISO)).toBeInTheDocument();
    expect(botaoJuntarContatos()).toBeDisabled();
    fireEvent.click(confirmacao().getByRole("checkbox", { name: "São a mesma pessoa" }));
    expect(botaoJuntarContatos()).toBeEnabled();
    fireEvent.click(botaoJuntarContatos());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith("/api/v1/contacts/merge", {
      primary_contact_id: PACIENTE,
      secondary_contact_ids: [IRMA],
      confirmar_ficha_do_prontuario: true,
    });
  });
});

describe("MergeDialog: grupo forte não sabe do vínculo", () => {
  it("o 409 prontuario_confirmar_juncao reabre a confirmação com o aviso e a caixa, sem toast de erro", async () => {
    // Sabotagem: sem tratar o 409 a confirmação fecha, o toast genérico aparece e não há como confirmar.
    getMock.mockResolvedValue({
      data: [{ chave: "g1", motivos: ["telefone"], principal_sugerido: PACIENTE, contatos: [contato(PACIENTE, "Ana Teste"), contato(IRMA, "Bia Teste")] }],
    });
    postMock.mockRejectedValueOnce(conflito409()).mockResolvedValueOnce(RESULTADO);
    const { MergeDialog } = await import("@/components/contacts/MergeDialog");
    comProvider(<MergeDialog open onOpenChange={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Juntar" }));
    expect(confirmacao().queryByText(AVISO)).toBeNull();
    fireEvent.click(botaoJuntarContatos());

    await waitFor(() => expect(confirmacao().getByText(AVISO)).toBeInTheDocument());
    expect(showApiErrorMock).not.toHaveBeenCalled();
    expect(postMock.mock.calls[0]![1]).not.toHaveProperty("confirmar_ficha_do_prontuario");
    expect(botaoJuntarContatos()).toBeDisabled();
    fireEvent.click(confirmacao().getByRole("checkbox", { name: "São a mesma pessoa" }));
    fireEvent.click(botaoJuntarContatos());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]![1]).toEqual({
      primary_contact_id: PACIENTE,
      secondary_contact_ids: [IRMA],
      confirmar_ficha_do_prontuario: true,
    });
  });
});

describe("JuntarComOutraFicha", () => {
  async function abrirComparacao(pacienteLigada: boolean) {
    getMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/v1/contacts/compare")) {
        return { data: { contatos: [ficha(PACIENTE, "Ana Teste", pacienteLigada), ficha(IRMA, "Bia Teste", false)] } };
      }
      return { data: [{ ...contato(IRMA, "Bia Teste"), is_anonymized: false, is_merged_into: null }], meta: { has_more: false } };
    });
    const { JuntarComOutraFicha } = await import("@/components/contacts/JuntarComOutraFicha");
    comProvider(
      <JuntarComOutraFicha contatoAtual={{ id: PACIENTE, name: "Ana Teste", display_name: null, phone_number: null }} open onOpenChange={() => undefined} />,
    );
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Bia" } });
    fireEvent.click(await screen.findByRole("button", { name: "Comparar" }));
    const juntar = await screen.findByRole("button", { name: "Juntar" });
    await waitFor(() => expect(juntar).toBeEnabled());
    fireEvent.click(juntar);
  }

  it("quem fica está no prontuário: a caixa é exigida e o campo vai", async () => {
    postMock.mockResolvedValue(RESULTADO);
    await abrirComparacao(true);

    expect(confirmacao().getByText(AVISO)).toBeInTheDocument();
    expect(botaoJuntarContatos()).toBeDisabled();
    fireEvent.click(confirmacao().getByRole("checkbox", { name: "São a mesma pessoa" }));
    fireEvent.click(botaoJuntarContatos());

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock.mock.calls[0]![1]).toEqual({
      primary_contact_id: PACIENTE,
      secondary_contact_ids: [IRMA],
      confirmar_ficha_do_prontuario: true,
    });
  });

  it("comparação velha (sem vínculo) e o servidor diz 409: reabre com a caixa", async () => {
    postMock.mockRejectedValueOnce(conflito409()).mockResolvedValueOnce(RESULTADO);
    await abrirComparacao(false);

    expect(confirmacao().queryByText(AVISO)).toBeNull();
    fireEvent.click(botaoJuntarContatos());

    await waitFor(() => expect(confirmacao().getByText(AVISO)).toBeInTheDocument());
    fireEvent.click(confirmacao().getByRole("checkbox", { name: "São a mesma pessoa" }));
    fireEvent.click(botaoJuntarContatos());
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    expect(postMock.mock.calls[1]![1]).toMatchObject({ confirmar_ficha_do_prontuario: true });
  });
});
