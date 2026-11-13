/**
 * A duração do atendimento escolhida na marcação (porte do upstream
 * DeskcommCRM #3714). Nomes fictícios.
 *
 * O que não pode se perder:
 *   1. Os horários livres respeitam a duração escolhida: 09:00 não aparece livre
 *      para 90 minutos se há paciente às 10:00.
 *   2. O passo da grade não muda (09:00, 09:30, 10:00…).
 *   3. A tela abre com a duração do procedimento, trava o Confirmar com valor
 *      inválido e só manda `duracaoMin` quando a recepção mudou o campo.
 *   4. Remarcar preserva o comprimento do bloco.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: () => Promise.resolve({ data: { contacts: [], conversations: [] } }),
    post: () => Promise.resolve({ data: {} }),
    delete: () => Promise.resolve({}),
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));

import { MarcacaoSimples } from "@/components/agenda/MarcacaoSimples";
import type { Pessoa } from "@/components/agenda/tipos";
import { duracaoDoBloco, duracaoDoCampo, duracaoEscolhidaValida } from "@/lib/agenda/duracao-escolhida";
import { partesNoFuso } from "@/lib/agenda/fuso";
import { horariosLivres, type Slot, type TipoDeAgendamento } from "@/lib/agenda/horarios-livres";

afterEach(cleanup);

const SP = "America/Sao_Paulo";
// 2026-03-09 é segunda. Manhã 09:00–12:00 em São Paulo (UTC-3).
const JORNADA = { timezone: SP, windows: [{ dow: 1, start: "09:00", end: "12:00" }] };
const CONSULTA_30: TipoDeAgendamento = {
  duracaoMin: 30,
  bufferAntesMin: 0,
  bufferDepoisMin: 0,
  avisoMinimoMin: 0,
  janelaDias: 60,
};
const DIA = { de: new Date("2026-03-09T00:00:00Z"), ate: new Date("2026-03-09T23:59:59Z") };
const AGORA = new Date("2026-03-01T12:00:00Z");

function horas(slots: Slot[]): string[] {
  return slots.map((s) => {
    const p = partesNoFuso(s.inicio, SP);
    return `${String(p.hora).padStart(2, "0")}:${String(p.minuto).padStart(2, "0")}`;
  });
}

describe("motor: os horários livres respeitam a duração escolhida", () => {
  const base = { jornada: JORNADA, excecoes: [], tipo: CONSULTA_30, ...DIA, agora: AGORA };

  it("sem escolha, slots de 30 como antes", () => {
    expect(horas(horariosLivres({ ...base, ocupados: [] }))).toEqual([
      "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    ]);
  });

  it("90 minutos: o passo continua de 30, e o slot que passaria das 12:00 sai", () => {
    const slots = horariosLivres({ ...base, ocupados: [], duracaoMin: 90 });
    expect(horas(slots)).toEqual(["09:00", "09:30", "10:00", "10:30"]);
    expect(slots[0]!.fim.getTime() - slots[0]!.inicio.getTime()).toBe(90 * 60_000);
  });

  it("paciente às 10:00: para 90 minutos sobra só 10:30", () => {
    const ocupados = [{ inicio: new Date("2026-03-09T13:00:00Z"), fim: new Date("2026-03-09T13:30:00Z") }];
    expect(horas(horariosLivres({ ...base, ocupados }))).toEqual(["09:00", "09:30", "10:30", "11:00", "11:30"]);
    expect(horas(horariosLivres({ ...base, ocupados, duracaoMin: 90 }))).toEqual(["10:30"]);
  });

  it("valor inválido cai na duração do tipo (nunca slot de duração zero)", () => {
    expect(horas(horariosLivres({ ...base, ocupados: [], duracaoMin: 0 }))).toHaveLength(6);
    expect(horas(horariosLivres({ ...base, ocupados: [], duracaoMin: Number.NaN }))).toHaveLength(6);
  });
});

describe("regras puras da duração", () => {
  it("faixa 5…1440, inteiro", () => {
    for (const ok of [5, 30, 90, 1440]) expect(duracaoEscolhidaValida(ok)).toBe(true);
    for (const nao of [4, 1441, 0, -30, 30.5, Number.NaN, Infinity, "90"]) expect(duracaoEscolhidaValida(nao)).toBe(false);
  });

  it("campo: null é o padrão; texto inválido é null", () => {
    expect(duracaoDoCampo(null, 45)).toBe(45);
    expect(duracaoDoCampo(" 90 ", 45)).toBe(90);
    expect(duracaoDoCampo("", 45)).toBeNull();
    expect(duracaoDoCampo("3", 45)).toBeNull();
    expect(duracaoDoCampo("1e2", 45)).toBeNull();
  });

  it("remarcar preserva o comprimento; intervalo ilegível cai no padrão", () => {
    expect(duracaoDoBloco("2026-03-09T12:00:00Z", "2026-03-09T13:30:00Z", 30)).toBe(90);
    expect(duracaoDoBloco("2026-03-09T12:00:00Z", null, 30)).toBe(30);
    expect(duracaoDoBloco("2026-03-09T12:00:00Z", "2026-03-09T11:00:00Z", 30)).toBe(30);
  });
});

describe("tela: campo Duração no Novo agendamento", () => {
  const ANA = "11111111-1111-4111-8111-111111111111";
  const PESSOAS = [{ id: ANA, nome: "Dra. Ana Teste", trilha: "a" }] as unknown as Pessoa[];
  const TIPOS = [
    { id: "t-ana", nome: "Avaliação facial", duracaoMin: 45, donoId: ANA, localDetalhes: null, exigePaciente: false },
  ];
  const instante = "2026-10-22T16:00:00.000Z"; // 13:00 em São Paulo

  function Montar(props: Partial<ComponentProps<typeof MarcacaoSimples>>) {
    const [duracao, setDuracao] = useState<string | null>(null);
    return (
      <MarcacaoSimples
        ancora={new Date(2026, 9, 22, 12)}
        agora={new Date(2026, 9, 22, 8)}
        usuarioId={ANA}
        pessoas={PESSOAS}
        tipos={TIPOS}
        profissionalId={ANA}
        onProfissional={vi.fn()}
        tipoId="t-ana"
        onTipo={vi.fn()}
        contactId=""
        conversationId=""
        onVinculo={vi.fn()}
        unidades={[]}
        unidadeId=""
        onUnidade={vi.fn()}
        fuso={SP}
        horariosPorDia={{ "2026-10-22": [{ instante, rotulo: "13:00" }] }}
        publicouHorarios
        erroAoCarregar={false}
        fusoSuposto={false}
        onMesVisivel={vi.fn()}
        mesCarregado={new Date(2026, 9, 1)}
        permiteEncaixe
        podeBloquearDeOutros
        duracao={duracao}
        onDuracao={setDuracao}
        onConfirmar={vi.fn(() => Promise.resolve())}
        onVerNaAgenda={vi.fn()}
        {...props}
      />
    );
  }
  function montar(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <Montar {...props} />
      </QueryClientProvider>,
    );
  }

  it("abre com a duração do procedimento e, sem mexer, não manda duração", async () => {
    const onConfirmar = vi.fn(() => Promise.resolve());
    montar({ onConfirmar, horarioInicial: { instante, rotulo: "13:00" } });
    expect((screen.getByTestId("duracao-da-marcacao") as HTMLInputElement).value).toBe("45");
    expect(screen.getByTestId("faixa-do-horario").textContent).toBe("13:00 às 13:45");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]).toEqual([expect.objectContaining({ instante, duracaoMin: undefined })]);
  });

  it("mudar para 90 limpa o horário, recalcula o fim e confirma com 90", async () => {
    const onConfirmar = vi.fn(() => Promise.resolve());
    montar({ onConfirmar, horarioInicial: { instante, rotulo: "13:00" } });
    fireEvent.change(screen.getByTestId("duracao-da-marcacao"), { target: { value: "90" } });
    expect(screen.queryByTestId("faixa-do-horario")).toBeNull();
    fireEvent.click(screen.getByTestId("horario-13:00"));
    expect(screen.getByTestId("faixa-do-horario").textContent).toBe("13:00 às 14:30");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(onConfirmar.mock.calls[0]).toEqual([expect.objectContaining({ instante, duracaoMin: 90 })]);
  });

  it("valor fora da faixa avisa e trava o Confirmar", () => {
    montar();
    fireEvent.change(screen.getByTestId("duracao-da-marcacao"), { target: { value: "3" } });
    expect(screen.getByTestId("duracao-invalida").textContent).toBe("Escolha uma duração entre 5 e 1440 minutos.");
    fireEvent.click(screen.getByTestId("horario-13:00"));
    expect(screen.getByTestId("confirmar-marcacao")).toBeDisabled();
  });
});
