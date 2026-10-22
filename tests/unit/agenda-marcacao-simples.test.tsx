/**
 * O "Novo agendamento" simples (modal de duas abas).
 *
 * O que não pode se perder:
 *   1. A ORDEM: o procedimento só se escolhe depois do profissional, e só entre
 *      os que ele atende (dono do tipo, ou tipo sem dono).
 *   2. O FIM é calculado pela duração do procedimento e aparece no resumo.
 *   3. O BLOQUEIO grava pelo caminho que já existia (`POST /api/v1/agenda/excecoes`,
 *      `is_unavailable: true`), uma linha por dia do período.
 *
 * Nomes fictícios, de propósito.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
let excecoes: unknown[] = [];
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) =>
      Promise.resolve(url.includes("excecoes") ? { data: excecoes } : { data: { contacts: [], conversations: [] } }),
    post: (...a: unknown[]) => post(...a),
    delete: () => Promise.resolve({}),
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));

import { BloqueioDeHorario } from "@/components/agenda/BloqueioDeHorario";
import { MarcacaoSimples } from "@/components/agenda/MarcacaoSimples";
import type { Pessoa } from "@/components/agenda/tipos";
import {
  datasDoPeriodo,
  fimDoHorario,
  outrosProcedimentos,
  procedimentosDoProfissional,
} from "@/lib/agenda/marcacao-simples";

const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";
const PESSOAS = [
  { id: ANA, nome: "Dra. Ana Teste", trilha: "a" },
  { id: BETO, nome: "Dr. Beto Teste", trilha: "b" },
] as unknown as Pessoa[];
const TIPOS = [
  { id: "t-ana", nome: "Avaliação facial", duracaoMin: 45, donoId: ANA, localDetalhes: null },
  { id: "t-beto", nome: "Retorno", duracaoMin: 30, donoId: BETO, localDetalhes: null },
  { id: "t-livre", nome: "Aplicação", duracaoMin: 15, donoId: null, localDetalhes: null },
];

afterEach(cleanup);

describe("regras puras", () => {
  it("procedimento filtrado pelo profissional, e nada sem profissional", () => {
    expect(procedimentosDoProfissional(TIPOS, "").map((t) => t.id)).toEqual([]);
    expect(procedimentosDoProfissional(TIPOS, ANA).map((t) => t.id)).toEqual(["t-ana", "t-livre"]);
    expect(procedimentosDoProfissional(TIPOS, BETO).map((t) => t.id)).toEqual(["t-beto", "t-livre"]);
    // Os de outro dono não somem (o dono do tipo é o PADRÃO, não exclusivo): vão para o fim.
    expect(outrosProcedimentos(TIPOS, BETO).map((t) => t.id)).toEqual(["t-ana"]);
    expect(outrosProcedimentos(TIPOS, "")).toEqual([]);
  });

  it("fim = começo + duração", () => {
    expect(fimDoHorario("2026-10-22T15:00:00.000Z", 45)).toBe("2026-10-22T15:45:00.000Z");
  });

  it("período de dias, inclusive, com teto; sem fim é o próprio dia", () => {
    expect(datasDoPeriodo("2026-10-30", "2026-11-02", 62)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(datasDoPeriodo("2026-10-30", "", 62)).toEqual(["2026-10-30"]);
    expect(datasDoPeriodo("2026-10-30", "2026-10-01", 62)).toEqual(["2026-10-30"]);
    expect(datasDoPeriodo("2026-01-01", "2026-12-31", 62)).toHaveLength(62);
  });
});

function montarMarcacao(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base: ComponentProps<typeof MarcacaoSimples> = {
    ancora: new Date(2026, 9, 22, 12),
    agora: new Date(2026, 9, 22, 8),
    usuarioId: ANA,
    pessoas: PESSOAS,
    tipos: TIPOS,
    profissionalId: "",
    onProfissional: vi.fn(),
    tipoId: "",
    onTipo: vi.fn(),
    contactId: "",
    conversationId: "",
    onVinculo: vi.fn(),
    unidades: [],
    unidadeId: "",
    onUnidade: vi.fn(),
    fuso: "America/Sao_Paulo",
    horariosPorDia: {},
    publicouHorarios: true,
    erroAoCarregar: false,
    fusoSuposto: false,
    onMesVisivel: vi.fn(),
    mesCarregado: new Date(2026, 9, 1),
    permiteEncaixe: true,
    podeBloquearDeOutros: true,
    onConfirmar: vi.fn(() => Promise.resolve()),
    onVerNaAgenda: vi.fn(),
  };
  return render(
    <QueryClientProvider client={qc}>
      <MarcacaoSimples {...base} {...props} />
    </QueryClientProvider>,
  );
}

describe("Novo agendamento: profissional antes do procedimento", () => {
  it("sem profissional, o procedimento está desligado e vazio", () => {
    montarMarcacao();
    const proc = screen.getByTestId("procedimento-da-marcacao") as HTMLSelectElement;
    expect(proc.disabled).toBe(true);
    expect(within(proc).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("confirmar-marcacao")).toBeDisabled();
  });

  it("com o profissional, os procedimentos DELE vêm primeiro, com a duração; os de outros, num grupo no fim", () => {
    montarMarcacao({ profissionalId: BETO });
    const proc = screen.getByTestId("procedimento-da-marcacao") as HTMLSelectElement;
    expect(proc.disabled).toBe(false);
    const primeiroNivel = Array.from(proc.querySelectorAll(":scope > option")).map((o) => o.textContent);
    expect(primeiroNivel).toEqual(["Escolha o procedimento", "Retorno · 30 min", "Aplicação · 15 min"]);
    const grupo = proc.querySelector("optgroup")!;
    expect(grupo.label).toBe("Procedimentos de outros profissionais");
    expect(Array.from(grupo.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "Avaliação facial · 45 min",
    ]);
  });

  it("limpar o profissional limpa o procedimento (a ordem volta ao começo)", () => {
    const onTipo = vi.fn();
    const onProfissional = vi.fn();
    montarMarcacao({ profissionalId: ANA, tipoId: "t-ana", onTipo, onProfissional });
    fireEvent.change(screen.getByTestId("profissional-da-marcacao"), { target: { value: "" } });
    expect(onProfissional).toHaveBeenCalledWith("");
    expect(onTipo).toHaveBeenCalledWith("");
  });

  it("o horário escolhido mostra o fim calculado pela duração e confirma com o instante", async () => {
    const onConfirmar = vi.fn(() => Promise.resolve());
    // 13:00 em São Paulo = 16:00 UTC; 45 min de "Avaliação facial".
    const instante = "2026-10-22T16:00:00.000Z";
    montarMarcacao({
      profissionalId: ANA,
      tipoId: "t-ana",
      horarioInicial: { instante, rotulo: "13:00" },
      horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
      onConfirmar,
    });
    expect(screen.getByTestId("painel-de-marcacao").getAttribute("data-tempo")).toBe("confirmando");
    expect(screen.getByTestId("faixa-do-horario").textContent).toBe("13:00 às 13:45");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]).toEqual([
      expect.objectContaining({ instante, endereco: "", observacao: "" }),
    ]);
    await screen.findByTestId("ver-na-agenda");
  });
});

describe("Bloquear horário: o mesmo caminho da tela de dias fora da rotina", () => {
  beforeEach(() => {
    post.mockClear();
    excecoes = [];
  });

  function montarBloqueio() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <BloqueioDeHorario
          pessoas={[{ id: ANA, nome: "Dra. Ana Teste" }, { id: BETO, nome: "Dr. Beto Teste" }]}
          euId={ANA}
          podeEscolherQuem
          profissionalInicial={BETO}
          dataInicial="2026-10-22"
        />
      </QueryClientProvider>,
    );
  }

  it("uma faixa de horas em dois dias vira dois POSTs em /excecoes, fechando a agenda do profissional", async () => {
    montarBloqueio();
    fireEvent.change(screen.getByTestId("bloqueio-ate"), { target: { value: "2026-10-23" } });
    fireEvent.change(screen.getByTestId("bloqueio-hora-de"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByTestId("bloqueio-hora-ate"), { target: { value: "15:30" } });
    fireEvent.change(screen.getByTestId("bloqueio-comentario"), { target: { value: "Curso" } });
    fireEvent.click(screen.getByTestId("salvar-bloqueio"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls.map((c) => c[0])).toEqual(["/api/v1/agenda/excecoes", "/api/v1/agenda/excecoes"]);
    expect(post.mock.calls[0]?.[1]).toEqual({
      exception_date: "2026-10-22",
      user_id: BETO,
      is_unavailable: true,
      start_minute: 840,
      end_minute: 930,
      reason: "Curso",
    });
    expect((post.mock.calls[1]?.[1] as { exception_date: string }).exception_date).toBe("2026-10-23");
  });

  it("dia inteiro manda 0..1440", async () => {
    montarBloqueio();
    fireEvent.click(screen.getByTestId("bloqueio-dia-inteiro"));
    fireEvent.click(screen.getByTestId("salvar-bloqueio"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({ start_minute: 0, end_minute: 1440, is_unavailable: true });
  });

  it("hora final antes da inicial não deixa salvar", () => {
    montarBloqueio();
    fireEvent.change(screen.getByTestId("bloqueio-hora-ate"), { target: { value: "11:00" } });
    expect(screen.getByTestId("salvar-bloqueio")).toBeDisabled();
  });

  it("lista os bloqueios ativos SÓ do profissional escolhido", async () => {
    excecoes = [
      { id: "x1", user_id: BETO, exception_date: "2026-10-24", is_unavailable: true, start_minute: 600, end_minute: 660, reason: null },
      { id: "x2", user_id: ANA, exception_date: "2026-10-25", is_unavailable: true, start_minute: 0, end_minute: 1440, reason: null },
      { id: "x3", user_id: BETO, exception_date: "2026-10-26", is_unavailable: false, start_minute: 600, end_minute: 660, reason: null },
    ];
    montarBloqueio();
    const lista = await screen.findByTestId("bloqueios-ativos");
    expect(within(lista).getAllByRole("listitem")).toHaveLength(1);
    expect(lista.textContent).toContain("10:00–11:00");
  });
});
