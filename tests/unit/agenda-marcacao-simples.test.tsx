/**
 * O "Novo agendamento" simples (modal de duas abas).
 *
 * O que não pode se perder:
 *   1. A ORDEM: o procedimento só se escolhe depois do profissional, e só entre
 *      os que ele atende (dono do tipo, ou tipo sem dono). A unidade, só entre
 *      as da jornada dele.
 *   2. O FIM é calculado pela duração do procedimento e aparece no resumo.
 *   3. O BLOQUEIO grava pelo caminho que já existia (`POST /api/v1/agenda/excecoes`,
 *      `is_unavailable: true`), uma linha por dia do período.
 *
 * Nomes fictícios, de propósito.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
const patch = vi.fn((..._a: unknown[]) => Promise.resolve({ data: {} }));
let excecoes: unknown[] = [];
let leiturasDeExcecoes = 0;
/** A ficha do paciente escolhido (origem do lead); `null` = nenhum. */
let ficha: Record<string, unknown> | null = null;
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (url: string) => {
      if (url.includes("excecoes")) leiturasDeExcecoes++;
      if (ficha && url.startsWith("/api/v1/contacts/")) return Promise.resolve({ data: ficha });
      if (ficha && url.startsWith("/api/v1/agenda/vinculos"))
        return Promise.resolve({ data: { contacts: [ficha], conversations: [] } });
      return Promise.resolve(url.includes("excecoes") ? { data: excecoes } : { data: { contacts: [], conversations: [] } });
    },
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
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
  atendeOProcedimento,
  dataDeCalendario,
  datasDoPeriodo,
  fimDoHorario,
  idadeEmAnos,
  ofertaDeUnidades,
  pacienteNovoPeloTipo,
  procedimentosDoProfissional,
  ultimaEProximaConsulta,
  unidadeDaMarcacao,
  unidadesDaJornada,
} from "@/lib/agenda/marcacao-simples";

/** Bônus (0417): a marcação nova exige o canal; o teste escolhe "Mensagem" ao montar. */
function comCanal<T>(r: T): T {
  const canal = screen.queryByTestId("canal-mensagem");
  if (canal) fireEvent.click(canal);
  return r;
}


const ANA = "11111111-1111-4111-8111-111111111111";
const BETO = "22222222-2222-4222-8222-222222222222";
const PESSOAS = [
  { id: ANA, nome: "Dra. Ana Teste", trilha: "a" },
  { id: BETO, nome: "Dr. Beto Teste", trilha: "b" },
] as unknown as Pessoa[];
const TIPOS = [
  { id: "t-ana", nome: "Avaliação facial", duracaoMin: 45, donoId: ANA, localDetalhes: null, exigePaciente: false },
  { id: "t-beto", nome: "Retorno", duracaoMin: 30, donoId: BETO, localDetalhes: null, exigePaciente: false },
  { id: "t-livre", nome: "Aplicação", duracaoMin: 15, donoId: null, localDetalhes: null, exigePaciente: false },
];

afterEach(cleanup);

describe("regras puras", () => {
  it("procedimento filtrado pelo profissional, e nada sem profissional", () => {
    expect(procedimentosDoProfissional(TIPOS, "").map((t) => t.id)).toEqual([]);
    expect(procedimentosDoProfissional(TIPOS, ANA).map((t) => t.id)).toEqual(["t-ana", "t-livre"]);
    expect(procedimentosDoProfissional(TIPOS, BETO).map((t) => t.id)).toEqual(["t-beto", "t-livre"]);
    // O de outro dono NÃO aparece (pedido do dono da clínica, 20/11): nem num grupo no fim.
    expect(atendeOProcedimento(ANA, BETO)).toBe(false);
    expect(atendeOProcedimento(null, BETO)).toBe(true);
    expect(atendeOProcedimento(null, "")).toBe(false);
  });

  it("unidades: só as da jornada; sem jornada que diga, todas, como sempre foi", () => {
    const U = [
      { id: "u-camburi", name: "Camburi", active: true },
      { id: "u-serra", name: "Serra", active: true },
      { id: "u-velha", name: "Antiga", active: false },
    ];
    expect(unidadesDaJornada([{ unit_id: "u-serra" }, { unit_id: "u-serra" }, {}])).toEqual({
      unidades: ["u-serra"],
      semUnidade: true,
    });
    // Só Serra na jornada: só Serra, sem "sem unidade", e ela já vem escolhida.
    const soSerra = ofertaDeUnidades(U, { unidades: ["u-serra"], atendeSemUnidade: false });
    expect(soSerra.unidades.map((u) => u.id)).toEqual(["u-serra"]);
    expect(soSerra.semUnidade).toBe(false);
    expect(unidadeDaMarcacao(soSerra, "")).toBe("u-serra");
    // A escolhida que não é dele cai.
    expect(unidadeDaMarcacao(soSerra, "u-camburi")).toBe("u-serra");
    // Duas unidades e nenhuma janela sem unidade: falta escolher ("").
    const duas = ofertaDeUnidades(U, { unidades: ["u-camburi", "u-serra"] });
    expect(unidadeDaMarcacao(duas, "")).toBe("");
    expect(unidadeDaMarcacao(duas, "u-camburi")).toBe("u-camburi");
    // Jornada que não diz onde: todas as ativas + "sem unidade", e a tela avisa.
    const legado = ofertaDeUnidades(U, { unidades: [] });
    expect(legado).toMatchObject({ semUnidade: true, daJornada: false });
    expect(legado.unidades.map((u) => u.id)).toEqual(["u-camburi", "u-serra"]);
    expect(ofertaDeUnidades(U, undefined).daJornada).toBe(false);
    // Unidade da jornada desativada não deixa o campo sem opção.
    expect(ofertaDeUnidades(U, { unidades: ["u-velha"] })).toMatchObject({ unidades: [], semUnidade: true });
  });

  it("idade pelo dia de calendário, sem fuso; data ilegível ou futura não tem idade", () => {
    const agora = new Date(2026, 10, 20, 12);
    expect(idadeEmAnos("1990-11-20", agora)).toBe(36);
    expect(idadeEmAnos("1990-11-21", agora)).toBe(35);
    expect(idadeEmAnos("2030-01-01", agora)).toBeNull();
    expect(idadeEmAnos(null, agora)).toBeNull();
    expect(dataDeCalendario("1990-03-12")).toBe("12/03/1990");
  });

  it("última consulta que passou e a próxima que vem", () => {
    const agora = new Date("2026-11-20T12:00:00Z");
    const c = (id: string, starts_at: string) => ({ id, starts_at, title: id });
    const r = ultimaEProximaConsulta(
      [c("futura-longe", "2026-12-20T12:00:00Z"), c("futura", "2026-11-25T12:00:00Z"), c("velha", "2026-01-01T12:00:00Z"), c("recente", "2026-11-10T12:00:00Z")],
      agora,
    );
    expect(r.ultima?.id).toBe("recente");
    expect(r.proxima?.id).toBe("futura");
    expect(ultimaEProximaConsulta([], agora)).toEqual({ ultima: null, proxima: null });
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

function propsBase(): ComponentProps<typeof MarcacaoSimples> {
  return {
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
}

function montarMarcacao(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}, semCanal = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={qc}>
      <MarcacaoSimples {...propsBase()} {...props} />
    </QueryClientProvider>,
  );
  return semCanal ? r : comCanal(r);
}

describe("Novo agendamento: profissional antes do procedimento", () => {
  it("sem profissional, o procedimento está desligado e vazio", () => {
    montarMarcacao();
    const proc = screen.getByTestId("procedimento-da-marcacao") as HTMLSelectElement;
    expect(proc.disabled).toBe(true);
    expect(within(proc).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("confirmar-marcacao")).toBeDisabled();
    // A duração espera o procedimento: desligada, e não "inválida" (sem borda de erro).
    expect(screen.getByTestId("duracao-da-marcacao")).toBeDisabled();
    expect(screen.getByTestId("duracao-da-marcacao")).not.toHaveAttribute("aria-invalid");
  });

  it("com o profissional, SÓ os procedimentos dele (e os sem dono), com a duração", () => {
    montarMarcacao({ profissionalId: BETO });
    const proc = screen.getByTestId("procedimento-da-marcacao") as HTMLSelectElement;
    expect(proc.disabled).toBe(false);
    expect(Array.from(proc.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "Escolha o procedimento",
      "Retorno · 30 min",
      "Aplicação · 15 min",
    ]);
    expect(proc.querySelector("optgroup")).toBeNull();
  });

  it("o procedimento de OUTRO profissional que sobrou no estado não conta como escolhido", () => {
    montarMarcacao({ profissionalId: BETO, tipoId: "t-ana" });
    expect((screen.getByTestId("procedimento-da-marcacao") as HTMLSelectElement).value).toBe("");
    expect(screen.getByTestId("painel-de-marcacao").getAttribute("data-tempo")).toBe("escolhendo-dia");
  });

  it("profissional sem procedimento não aparece na lista, e o que vinha escolhido é limpo (21/11)", () => {
    const soDaAna = TIPOS.filter((t) => t.donoId === ANA);
    const onProfissional = vi.fn();
    montarMarcacao({ profissionalId: BETO, tipos: soDaAna, onProfissional });
    const lista = screen.getByTestId("profissional-da-marcacao") as HTMLSelectElement;
    const nomes = within(lista).getAllByRole("option").map((o) => o.textContent);
    expect(nomes.some((n) => n?.includes("Beto"))).toBe(false);
    expect(nomes.some((n) => n?.includes("Ana"))).toBe(true);
    expect(onProfissional).toHaveBeenCalledWith("");
    expect(screen.queryByTestId("sem-procedimento-do-profissional")).toBeNull();
  });

  it("ninguém com procedimento: o aviso explica e aponta onde cadastrar", () => {
    montarMarcacao({ tipos: [] });
    const aviso = screen.getByTestId("sem-procedimento-do-profissional");
    expect(aviso).toHaveTextContent("Nenhum profissional tem procedimento cadastrado.");
    expect(within(aviso).getByRole("link")).toHaveAttribute("href", "/app/settings/tenant/agenda");
  });

  it("limpar o profissional limpa o procedimento (a ordem volta ao começo)", () => {
    const onTipo = vi.fn();
    const onProfissional = vi.fn();
    montarMarcacao({ profissionalId: ANA, tipoId: "t-ana", onTipo, onProfissional });
    fireEvent.change(screen.getByTestId("profissional-da-marcacao"), { target: { value: "" } });
    expect(onProfissional).toHaveBeenCalledWith("");
    expect(onTipo).toHaveBeenCalledWith("");
  });

  it("trocar profissional ou procedimento esvazia a hora, até a digitada que não virou horário", () => {
    // Sem encaixe, 10:30 fica no campo com o aviso, sem virar horário.
    const horariosPorDia = { "2026-10-22": [{ instante: "2026-10-22T16:00:00.000Z", rotulo: "13:00" }] };
    montarMarcacao({ profissionalId: ANA, tipoId: "t-livre", permiteEncaixe: false, horariosPorDia });
    const hora = () => screen.getByTestId("hora-da-marcacao") as HTMLInputElement;
    fireEvent.change(hora(), { target: { value: "10:30" } });
    expect(screen.getByTestId("fora-dos-horarios-livres")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("profissional-da-marcacao"), { target: { value: BETO } });
    expect(hora().value).toBe("");
    expect(screen.queryByTestId("fora-dos-horarios-livres")).toBeNull();

    fireEvent.change(hora(), { target: { value: "10:30" } });
    fireEvent.change(screen.getByTestId("procedimento-da-marcacao"), { target: { value: "t-ana" } });
    expect(hora().value).toBe("");
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
      expect.objectContaining({ instante, endereco: "", observacao: "", canal: "mensagem" }),
    ]);
    await screen.findByTestId("ver-na-agenda");
  });
});

describe("unidade: só onde o profissional atende", () => {
  const UNIDADES = [
    { id: "u-camburi", name: "Camburi", active: true },
    { id: "u-serra", name: "Serra", active: true },
  ];
  const instante = "2026-10-22T16:00:00.000Z";
  const comHorario = {
    tipoId: "t-beto",
    unidades: UNIDADES,
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  };
  const comJornada = (unidades: string[], atendeSemUnidade = false) =>
    PESSOAS.map((p) => (p.id === BETO ? { ...p, unidades, atendeSemUnidade } : p));

  it("só as unidades da jornada; a única já vem escolhida", async () => {
    const onUnidade = vi.fn();
    montarMarcacao({ ...comHorario, profissionalId: BETO, pessoas: comJornada(["u-serra"]), onUnidade });
    const campo = screen.getByTestId("unidade-do-agendamento") as HTMLSelectElement;
    expect(Array.from(campo.options).map((o) => o.textContent)).toEqual(["Escolha a unidade", "Serra"]);
    await waitFor(() => expect(onUnidade).toHaveBeenCalledWith("u-serra"));
  });

  it("com janela sem unidade, oferece 'Teleconsulta ou sem unidade' ao lado das dele", () => {
    montarMarcacao({ ...comHorario, profissionalId: BETO, pessoas: comJornada(["u-camburi"], true) });
    const campo = screen.getByTestId("unidade-do-agendamento") as HTMLSelectElement;
    expect(Array.from(campo.options).map((o) => o.textContent)).toEqual(["Teleconsulta ou sem unidade", "Camburi"]);
    expect(screen.queryByTestId("unidades-sem-jornada")).toBeNull();
  });

  it("duas unidades e nenhuma escolhida: o Confirmar espera e diz o que falta", () => {
    montarMarcacao({ ...comHorario, profissionalId: BETO, pessoas: comJornada(["u-camburi", "u-serra"]) });
    expect(screen.getByTestId("confirmar-marcacao")).toBeDisabled();
    expect(screen.getByTestId("falta-unidade-na-marcacao")).toHaveTextContent("Escolha a unidade do atendimento.");
  });

  it("a unidade de outro profissional que sobrou no estado é trocada pela que vale", async () => {
    const onUnidade = vi.fn();
    montarMarcacao({
      ...comHorario,
      profissionalId: BETO,
      unidadeId: "u-camburi",
      pessoas: comJornada(["u-serra"]),
      onUnidade,
    });
    await waitFor(() => expect(onUnidade).toHaveBeenCalledWith("u-serra"));
  });

  it("jornada que não diz onde atende: todas as unidades, e a tela avisa por quê", () => {
    montarMarcacao({ ...comHorario, profissionalId: BETO });
    const campo = screen.getByTestId("unidade-do-agendamento") as HTMLSelectElement;
    expect(Array.from(campo.options).map((o) => o.textContent)).toEqual([
      "Teleconsulta ou sem unidade",
      "Camburi",
      "Serra",
    ]);
    expect(screen.getByTestId("unidades-sem-jornada")).toBeInTheDocument();
    expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled();
  });

  it("sem profissional, a unidade espera por ele", () => {
    montarMarcacao({ unidades: UNIDADES });
    expect(screen.getByTestId("unidade-do-agendamento")).toBeDisabled();
  });
});

describe("consulta exige paciente (migration 0411)", () => {
  const instante = "2026-10-22T16:00:00.000Z";
  const tiposQueExigem = TIPOS.map((t) => ({ ...t, exigePaciente: t.id === "t-ana" }));
  const comHorario = {
    profissionalId: ANA,
    tipoId: "t-ana",
    tipos: tiposQueExigem,
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  };

  it("sem paciente, Confirmar avisa ao lado do campo e NÃO envia", () => {
    const onConfirmar = vi.fn(() => Promise.resolve());
    montarMarcacao({ ...comHorario, onConfirmar });
    expect(screen.queryByTestId("falta-paciente-na-marcacao")).toBeNull();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    expect(screen.getByTestId("falta-paciente-na-marcacao").textContent).toBe(
      "Escolha o paciente para marcar uma consulta.",
    );
    expect(onConfirmar).not.toHaveBeenCalled();
  });

  it("o 422 patient_required do servidor aparece no mesmo lugar", async () => {
    const { ApiError } = await import("@/lib/api/types");
    const onConfirmar = vi.fn(() =>
      Promise.reject(new ApiError(422, "patient_required", undefined, "req", "Escolha o paciente para marcar uma consulta.")),
    );
    // O tipo local diz que não exige (tela defasada); quem decide é o servidor.
    montarMarcacao({ ...comHorario, tipos: TIPOS, onConfirmar });
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await screen.findByTestId("falta-paciente-na-marcacao");
    expect(screen.queryByTestId("recusa-da-marcacao")).toBeNull();
  });

  it("'Marcada por' já vem em Mensagem, e Ligação troca (pedido de 21/11)", () => {
    montarMarcacao({ ...comHorario, tipos: TIPOS }, true);
    expect(screen.getByTestId("canal-mensagem")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("falta-canal-na-marcacao")).toBeNull();
    expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled();
    fireEvent.click(screen.getByTestId("canal-ligacao"));
    expect(screen.getByTestId("canal-ligacao")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("canal-mensagem")).toHaveAttribute("aria-pressed", "false");
  });

  it("tipo que não exige marca sem paciente", async () => {
    const onConfirmar = vi.fn(() => Promise.resolve());
    montarMarcacao({ ...comHorario, tipos: TIPOS, onConfirmar });
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
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

  it("acima de 62 dias recusa à vista, sem gravar só o começo (achado 16, 16/11)", () => {
    montarBloqueio();
    fireEvent.click(screen.getByTestId("bloqueio-dia-inteiro"));
    // 22/10 a 31/12: 71 dias de férias.
    fireEvent.change(screen.getByTestId("bloqueio-ate"), { target: { value: "2026-12-31" } });
    expect(screen.getByTestId("salvar-bloqueio")).toBeDisabled();
    expect(screen.getByText(/no máximo 62 dias/)).toBeInTheDocument();
    // Exatamente 62 (22/10 a 22/12) ainda passa.
    fireEvent.change(screen.getByTestId("bloqueio-ate"), { target: { value: "2026-12-22" } });
    expect(screen.getByTestId("salvar-bloqueio")).toBeEnabled();
  });

  it("erro no meio do período: a lista relê os dias que já foram gravados", async () => {
    post.mockImplementationOnce(() => Promise.resolve({ data: {} }));
    post.mockImplementationOnce(() => Promise.reject(new Error("rede")));
    leiturasDeExcecoes = 0;
    montarBloqueio();
    await waitFor(() => expect(leiturasDeExcecoes).toBe(1));
    fireEvent.change(screen.getByTestId("bloqueio-ate"), { target: { value: "2026-10-23" } });
    fireEvent.click(screen.getByTestId("salvar-bloqueio"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(leiturasDeExcecoes).toBe(2));
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

describe("quem converteu e a origem do lead (21/11/2026)", () => {
  const instante = "2026-10-22T16:00:00.000Z";
  const PRIMEIRA = {
    id: "t-primeira",
    nome: "Primeira consulta",
    duracaoMin: 60,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "consulta",
  };
  const comHorario = {
    profissionalId: ANA,
    tipoId: "t-primeira",
    tipos: [...TIPOS, PRIMEIRA],
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  };
  const PACIENTE = {
    id: "c-ficticio",
    name: "Paciente Fictício Silva",
    display_name: null,
    phone_number: "+5527900000000",
    tags: ["Meta"],
    source: "whatsapp",
    source_metadata: {},
  };
  afterEach(() => {
    ficha = null;
    patch.mockClear();
  });

  it("vem com quem está marcando, e a IA do atendimento manda `ai`", async () => {
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario, onConfirmar });
    const campo = screen.getByTestId("quem-converteu") as HTMLSelectElement;
    expect(campo.value).toBe(`user:${ANA}`);
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]?.[0]).toMatchObject({ quemConverteu: { kind: "user", userId: ANA } });

    fireEvent.click(screen.getByText("Marcar outro"));
    fireEvent.change(screen.getByTestId("quem-converteu"), { target: { value: "ai" } });
    fireEvent.click(screen.getByTestId("horario-13:00"));
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalledTimes(2));
    expect(onConfirmar.mock.calls[1]?.[0]).toMatchObject({ quemConverteu: { kind: "ai" } });
  });

  it("a origem sai da ficha pela regra do funil, e só é gravada se mudou", async () => {
    ficha = PACIENTE;
    const onConfirmar = vi.fn(() => Promise.resolve());
    montarMarcacao({ ...comHorario, contactId: PACIENTE.id, onConfirmar });
    const origem = screen.getByTestId("origem-do-lead") as HTMLSelectElement;
    await waitFor(() => expect(origem.value).toBe("meta"));
    fireEvent.change(origem, { target: { value: "indicacao" } });
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[1]).toEqual({ origem_informada: "indicacao" });
  });

  it("sem mudar a origem, nada é gravado na ficha", async () => {
    ficha = PACIENTE;
    const onConfirmar = vi.fn(() => Promise.resolve());
    montarMarcacao({ ...comHorario, contactId: PACIENTE.id, onConfirmar });
    await waitFor(() => expect((screen.getByTestId("origem-do-lead") as HTMLSelectElement).value).toBe("meta"));
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
  });

  it("veio pelo clique no anúncio: a origem não se troca à mão", async () => {
    ficha = { ...PACIENTE, tags: [], source_metadata: { ad_platform: "google_ads" } };
    montarMarcacao({ ...comHorario, contactId: PACIENTE.id });
    const origem = screen.getByTestId("origem-do-lead") as HTMLSelectElement;
    await waitFor(() => expect(origem.value).toBe("google"));
    expect(origem).toBeDisabled();
    expect(screen.getByText("Marcada pelo clique no anúncio.")).toBeInTheDocument();
  });
});

describe("paciente novo ou antigo (decisão do André, 27/11/2026)", () => {
  const instante = "2026-10-22T16:00:00.000Z";
  const PRIMEIRA = {
    id: "t-primeira",
    nome: "Primeira consulta",
    duracaoMin: 60,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "consulta",
  };
  const APLICACAO = {
    id: "t-aplicacao",
    nome: "Aplicação de vitamina D",
    duracaoMin: 15,
    donoId: ANA,
    localDetalhes: null,
    exigePaciente: false,
    categoria: "procedimento",
  };
  const PACIENTE = {
    id: "c-ficticio-2",
    name: "Paciente Fictícia Rocha",
    display_name: null,
    phone_number: "+5527900000001",
    tags: ["Meta"],
    source: "whatsapp",
    source_metadata: {},
  };
  const comHorario = (tipoId: string) => ({
    profissionalId: ANA,
    tipoId,
    tipos: [...TIPOS, PRIMEIRA, APLICACAO],
    horarioInicial: { instante, rotulo: "13:00" },
    horariosPorDia: { "2026-10-22": [{ instante, rotulo: "13:00" }] },
  });
  afterEach(() => {
    ficha = null;
    patch.mockClear();
  });

  it("regra pura: só a 'Primeira…' de categoria consulta é paciente novo", () => {
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "Primeira consulta" })).toBe(true);
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "  primeira vez" })).toBe(true);
    expect(pacienteNovoPeloTipo({ categoria: "consulta", nome: "Consulta de acompanhamento" })).toBe(false);
    expect(pacienteNovoPeloTipo({ categoria: "retorno", nome: "Primeira revisão" })).toBe(false);
    expect(pacienteNovoPeloTipo({ categoria: null, nome: "Primeira consulta" })).toBe(false);
    expect(pacienteNovoPeloTipo(null)).toBe(false);
  });

  it("primeira consulta abre em Paciente novo, com Quem converteu e Origem", () => {
    montarMarcacao(comHorario("t-primeira"));
    expect(screen.getByTestId("paciente-novo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("quem-converteu")).toBeInTheDocument();
    expect(screen.getByTestId("origem-do-lead")).toBeInTheDocument();
  });

  it("aplicação abre em Paciente antigo: os dois campos somem e o confirmar diz 'sem conversão'", async () => {
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario("t-aplicacao"), onConfirmar });
    expect(screen.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("quem-converteu")).toBeNull();
    expect(screen.queryByTestId("origem-do-lead")).toBeNull();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    // `null` explícito, não ausente: ausente a rota grava quem marca como quem converteu.
    expect(onConfirmar.mock.calls[0]?.[0]).toHaveProperty("quemConverteu", null);
  });

  it("antigo e de volta a novo no mesmo procedimento: quem converteu volta a ir", async () => {
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario("t-aplicacao"), onConfirmar });
    expect(screen.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("paciente-novo"));
    expect(screen.getByTestId("quem-converteu")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]?.[0]).toMatchObject({ quemConverteu: { kind: "user", userId: ANA } });
  });

  it("mexer na Origem e trocar para antigo: nada é gravado na ficha", async () => {
    ficha = PACIENTE;
    const onConfirmar = vi.fn((_m: unknown) => Promise.resolve());
    montarMarcacao({ ...comHorario("t-primeira"), contactId: PACIENTE.id, onConfirmar });
    const origem = screen.getByTestId("origem-do-lead") as HTMLSelectElement;
    await waitFor(() => expect(origem.value).toBe("meta"));
    fireEvent.change(origem, { target: { value: "indicacao" } });
    fireEvent.click(screen.getByTestId("paciente-antigo"));
    expect(screen.queryByTestId("origem-do-lead")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
    expect(onConfirmar.mock.calls[0]?.[0]).toHaveProperty("quemConverteu", null);
  });

  it("a troca vale só para o procedimento em que foi feita: outro procedimento volta ao padrão dele", () => {
    function ComProcedimento() {
      const [tipoId, setTipoId] = useState("t-aplicacao");
      return <MarcacaoSimples {...propsBase()} {...comHorario(tipoId)} onTipo={setTipoId} />;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ComProcedimento />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("paciente-novo"));
    expect(screen.getByTestId("quem-converteu")).toBeInTheDocument();
    // "Avaliação facial" (t-ana) não tem categoria: o padrão dela é antigo.
    fireEvent.change(screen.getByTestId("procedimento-da-marcacao"), { target: { value: "t-ana" } });
    expect(screen.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("quem-converteu")).toBeNull();
  });
});
