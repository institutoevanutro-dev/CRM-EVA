/**
 * Lote L1 da auditoria de 16/11 (Agenda), pela tela inteira montada:
 *
 *  - achado 1: REMARCAR pergunta os horários do procedimento e do dono DO
 *    COMPROMISSO, não do tipo escolhido na grade (que oferecia a agenda do
 *    "Dr. A" para uma consulta da "Dra. B"). O arraste segue a mesma regra.
 *  - achado 13: "Ver na agenda" fecha pelo mesmo caminho do X — o horário
 *    escolhido não sobra para a remarcação seguinte.
 *  - achado 19: o relógio anda; depois da meia-noite "Hoje" é o dia novo.
 *
 * Mesmos dublês de `agenda-clique-e-profissionais.test.tsx`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { AgendaClient } from "@/app/app/agenda/_client";
import { useAgora } from "@/hooks/agenda/useAgora";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: (url: string) => window.history.pushState(null, "", url),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/app/agenda",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useAuth: () => ({ user: { id: "u1" }, activeOrg: { id: "o1", role: "agent" } }),
}));

const traduzir = Object.assign((texto: string) => texto, { t: (texto: string) => texto });
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => traduzir }));
vi.mock("@/hooks/i18n/useLocaleDeData", async () => {
  const { ptBR } = await import("date-fns/locale");
  return { useLocaleDeData: () => ptBR, useTagDeIdioma: () => "pt-BR" };
});

/** Todo pedido de horários livres, para saber DE QUEM a tela perguntou. */
const pedidos = vi.hoisted(() => [] as Array<{ event_type_id: string; owner_user_id?: string } | null>);
vi.mock("@/hooks/agenda/useHorariosLivres", () => ({
  useHorariosLivres: (argumento: { event_type_id: string; owner_user_id?: string } | null) => {
    pedidos.push(argumento);
    // Jornada publicada e nenhuma vaga na janela: é o encaixe que torna o bloco clicável.
    return {
      data: { slots: [], fuso_da_regra: "America/Sao_Paulo", publicou_horarios: true },
      isError: false,
      isLoading: false,
    };
  },
}));

const compromissos = vi.hoisted(() => [] as Array<Record<string, unknown>>);
// O canal ao vivo tem teste próprio (`agenda-ao-vivo.test.tsx`); aqui não há Supabase.
vi.mock("@/hooks/agenda/useAgendaAoVivo", () => ({ useAgendaAoVivo: () => ({}) }));
vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () => ({ data: compromissos, isError: false, isLoading: false }),
}));
const remarcarSpy = vi.hoisted(() => vi.fn(async (_c: Record<string, unknown>) => ({})));
const marcar = vi.hoisted(() => vi.fn(async (_corpo: Record<string, unknown>) => ({})));
vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: marcar, isPending: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: remarcarSpy, isPending: false }),
}));
const PESSOAS = vi.hoisted(() => [
  { id: "p-ana", nome: "Ana", trilha: 1 as const },
  { id: "p-bia", nome: "Bia", trilha: 2 as const },
  { id: "p-caio", nome: "Caio", trilha: 3 as const },
]);
vi.mock("@/hooks/agenda/usePessoasDaAgenda", () => ({
  usePessoasDaAgenda: () => ({ data: PESSOAS, isError: false, isLoading: false }),
}));
vi.mock("@/lib/agenda/vinculo-da-marcacao", () => ({
  useVinculoDaMarcacao: () => ({
    vinculo: { contact: null, conversation: null },
    registrarRota: vi.fn(() => false),
    reiniciar: vi.fn(),
    escolher: vi.fn(),
  }),
}));
vi.mock("@/components/agenda/VinculoDaMarcacao", () => ({ VinculoDaMarcacao: () => null }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [] })) },
}));

/** O painel real busca o detalhe na rede; aqui só importa o Remarcar que ele recebe. */
vi.mock("@/components/agenda/EntradaDaAgenda", () => ({
  EntradaDaAgenda: (props: { remarcacao?: { aberta: boolean; onAbrir: (comecaEm: string) => void } }) =>
    props.remarcacao ? (
      <button
        type="button"
        data-testid="abrir-remarcacao-de-fora"
        data-aberta={String(props.remarcacao.aberta)}
        onClick={() => props.remarcacao!.onAbrir("2030-02-20T10:00:00-03:00")}
      >
        remarcar
      </button>
    ) : null,
}));

/**
 * A marcação NOVA mora no modal simples (`MarcacaoSimples`); o dublê mostra o
 * que ele recebeu: o horário do bloco, o profissional e o procedimento.
 */
vi.mock("@/components/agenda/MarcacaoSimples", () => ({
  MarcacaoSimples: (props: {
    horarioInicial?: { instante: string; rotulo: string };
    profissionalId: string;
    tipoId: string;
    onConfirmar: (m: { instante: string; endereco: string; observacao: string }) => unknown;
    onVerNaAgenda: (instante: string) => void;
  }) => (
    <div
      data-testid="painel-dublê"
      data-instante={props.horarioInicial?.instante ?? ""}
      data-rotulo={props.horarioInicial?.rotulo ?? ""}
      data-profissional={props.profissionalId}
      data-tipo={props.tipoId}
    >
      <button
        type="button"
        onClick={() =>
          props.onConfirmar({ instante: props.horarioInicial!.instante, endereco: "", observacao: "" })
        }
      >
        confirmar
      </button>
      <button type="button" onClick={() => props.onVerNaAgenda(props.horarioInicial!.instante)}>
        ver na agenda
      </button>
    </div>
  ),
}));


const TIPOS = [
  { id: "tipo-1", nome: "Consulta", duracaoMin: 30, donoId: "p-ana", localKind: null, localDetalhes: null, exigePaciente: false },
  { id: "tipo-2", nome: "Retorno", duracaoMin: 30, donoId: "p-ana", localKind: null, localDetalhes: null, exigePaciente: false },
];
const HOJE = "2030-01-15";
const QUARTA = "2030-01-16";

function montar(hoje = HOJE) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        hojeNaOrganizacao={hoje}
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={TIPOS}
        agendamentosIniciais={[]}
        usuarioId="u-recepcao"
        podeMarcar
      />
    </QueryClientProvider>,
  );
}

/** Um "Retorno" (tipo-2) da Bia — a grade está em "Consulta" (tipo-1, da Ana). */
const RETORNO_DA_BIA = {
  id: "c-bia",
  titulo: "Retorno",
  tipoId: "tipo-2",
  tipo: "Retorno",
  responsavelId: "p-bia",
  quemSeraAtendido: "Paciente Fictícia",
  comeca: `${QUARTA}T10:00:00-03:00`,
  termina: `${QUARTA}T10:30:00-03:00`,
  origem: "ui",
  situacao: "confirmed",
};


beforeEach(() => {
  window.history.replaceState(null, "", "/app/agenda");
  window.localStorage.clear();
  pedidos.length = 0;
  compromissos.length = 0;
  marcar.mockClear();
  remarcarSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("achado 1: remarcar pergunta pela agenda DO compromisso", () => {
  it("o Remarcar da recusa do arraste pede os horários do procedimento e da dona dele", () => {
    compromissos.push(RETORNO_DA_BIA);
    montar();
    const card = screen.getByTestId("agendamento-c-bia");
    card.focus();
    fireEvent.keyDown(card, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.getByTestId("remarcacao-recusada").textContent).toContain("outro profissional ou procedimento");
    expect(remarcarSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("remarcacao-recusada-remarcar"));
    expect(new URLSearchParams(window.location.search).get("compromisso")).toBe("c-bia");
    // A grade (atrás do painel) segue perguntando pelo tipo dela; o REMARCAR não.
    const doRemarcar = pedidos.filter((p) => p !== null && "duracao_minutos" in p);
    expect(doRemarcar.at(-1)).toMatchObject({ event_type_id: "tipo-2", owner_user_id: "p-bia" });
  });
});

describe("remarcar compromisso aberto por link, fora da semana carregada", () => {
  it("a grade vai até a semana dele, e nenhum horário é pedido com o procedimento da grade", () => {
    window.history.replaceState(null, "", "/app/agenda?compromisso=c-fora");
    montar();
    pedidos.length = 0;
    fireEvent.click(screen.getByTestId("abrir-remarcacao-de-fora"));
    expect(screen.getByTestId("periodo").textContent).toContain("fev");
    expect(pedidos.filter((p) => p !== null && "duracao_minutos" in p)).toEqual([]);
  });
});

describe("o voltar do navegador fecha o painel e esquece o Remarcar", () => {
  it("reabrir o mesmo compromisso depois do voltar não abre já remarcando", () => {
    window.history.replaceState(null, "", "/app/agenda?compromisso=c-fora");
    montar();
    fireEvent.click(screen.getByTestId("abrir-remarcacao-de-fora"));
    expect(screen.getByTestId("abrir-remarcacao-de-fora")).toHaveAttribute("data-aberta", "true");
    // O voltar troca a URL sem passar pelo `onOpenChange` do painel; qualquer
    // renderização seguinte lê a URL nova (o dublê de `useSearchParams` a lê).
    window.history.pushState(null, "", "/app/agenda");
    fireEvent.click(screen.getByTestId("visao-dia"));
    expect(screen.queryByTestId("abrir-remarcacao-de-fora")).toBeNull();
    window.history.pushState(null, "", "/app/agenda?compromisso=c-fora");
    fireEvent.click(screen.getByTestId("visao-semana"));
    expect(screen.getByTestId("abrir-remarcacao-de-fora")).toHaveAttribute("data-aberta", "false");
  });
});

describe("achado 13: 'Ver na agenda' limpa o horário escolhido", () => {
  it("a marcação seguinte não abre com o horário do bloco clicado antes", async () => {
    montar();
    fireEvent.click(screen.getByTestId(`bloco-${QUARTA}-14:30`));
    expect(await screen.findByTestId("painel-dublê")).toHaveAttribute(
      "data-instante",
      new Date(`${QUARTA}T14:30:00-03:00`).toISOString(),
    );
    fireEvent.click(screen.getByRole("button", { name: "ver na agenda" }));
    expect(screen.queryByTestId("painel-dublê")).toBeNull();

    fireEvent.click(screen.getByTestId("novo-agendamento"));
    expect(await screen.findByTestId("painel-dublê")).toHaveAttribute("data-instante", "");
  });
});

describe("achado 19: o relógio da agenda anda", () => {
  it("depois da meia-noite, 'Hoje' leva ao dia novo, não ao da abertura", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2030-01-15T23:58:00-03:00"));
    montar("2030-01-15");
    fireEvent.click(screen.getByTestId("visao-dia"));
    expect(screen.getByTestId("periodo").textContent).toContain("15 de janeiro");

    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(screen.getByTestId("periodo").textContent).toContain("16 de janeiro");
  });
});

describe("useAgora", () => {
  it("tique a cada minuto", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2030-01-15T10:00:00Z"));
    const { result } = renderHook(() => useAgora());
    const antes = result.current.getTime();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.getTime() - antes).toBe(60_000);
  });
});
