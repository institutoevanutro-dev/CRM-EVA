/**
 * A chave "Médico sem RQE" da aba Comentários (migration 0381).
 *
 * O que estes testes protegem:
 *  1. Só o administrador vê a chave: a rota e o banco recusam os outros papéis,
 *     e a tela não oferece o que vai ser recusado.
 *  2. A chave mostra o que o servidor diz, e o clique manda o booleano novo.
 *  3. Erro de leitura diz que não carregou, em vez de mostrar uma chave que
 *     pode estar mentindo.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ComentariosPainel } from "@/components/inbox/comentarios/ComentariosPainel";
import { RegraDoRqe } from "@/components/inbox/comentarios/RegraDoRqe";

const salvarMock = vi.fn();
let papel: string;
let regra: { data?: { ligada: boolean }; isLoading: boolean; isError: boolean };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { orgId: "org-1", name: "Org", role: papel } }),
}));
vi.mock("@/hooks/comentarios/useComentarios", () => ({
  useComentarios: () => ({ data: [], isLoading: false }),
  usePublicarComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useCriarRegraDeComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useDescartarComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useCanaisDoInstagram: () => ({ data: [] }),
  usePublicacoesDosPerfis: () => new Map(),
  usePublicacoesDoInstagram: () => ({ data: [], isLoading: false, isError: false }),
  useFrasesDeAbertura: () => ({ data: undefined, isLoading: true }),
  useSalvarFrasesDeAbertura: () => ({ mutate: vi.fn(), isPending: false }),
  usePalavrasDaIa: () => ({ data: undefined, isLoading: true, isError: false }),
  useDecidirPalavra: () => ({ mutate: vi.fn(), isPending: false }),
  useRegraDoRqe: () => regra,
  useSalvarRegraDoRqe: () => ({ mutate: salvarMock, isPending: false, variables: undefined }),
}));

beforeEach(() => {
  salvarMock.mockClear();
  papel = "admin";
  regra = { data: { ligada: true }, isLoading: false, isError: false };
});

describe("Médico sem RQE: quem vê", () => {
  it.each(["manager", "agent", "viewer"])("%s não vê o botão", (outro) => {
    papel = outro;
    render(<ComentariosPainel />);
    expect(screen.queryByRole("button", { name: "Médico sem RQE" })).toBeNull();
  });

  it("o administrador abre a chave pelo botão do cabeçalho", () => {
    render(<ComentariosPainel />);
    fireEvent.click(screen.getByRole("button", { name: "Médico sem RQE" }));
    expect(screen.getByRole("switch", { name: "Médico sem RQE" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Médico sem RQE: a chave", () => {
  it("organização que nunca mexeu vê a regra ligada, e desligar manda false", () => {
    render(<RegraDoRqe />);
    const chave = screen.getByRole("switch", { name: "Médico sem RQE" });
    expect(chave).toHaveAttribute("aria-checked", "true");
    fireEvent.click(chave);
    expect(salvarMock).toHaveBeenCalledWith(false);
  });

  it("regra desligada aparece desligada, e religar manda true", () => {
    regra = { data: { ligada: false }, isLoading: false, isError: false };
    render(<RegraDoRqe />);
    const chave = screen.getByRole("switch", { name: "Médico sem RQE" });
    expect(chave).toHaveAttribute("aria-checked", "false");
    fireEvent.click(chave);
    expect(salvarMock).toHaveBeenCalledWith(true);
  });

  it("diz quando desligar: médico com RQE ou clínica que não é médica", () => {
    render(<RegraDoRqe />);
    expect(screen.getByText(/tem RQE ou se a clínica não é médica/)).toBeInTheDocument();
  });

  it("erro de leitura: diz que não carregou e não mostra chave", () => {
    regra = { data: undefined, isLoading: false, isError: true };
    render(<RegraDoRqe />);
    expect(screen.getByText(/Não foi possível carregar a regra/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("enquanto carrega, não mostra chave que possa ser clicada por engano", () => {
    regra = { data: undefined, isLoading: true, isError: false };
    render(<RegraDoRqe />);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
