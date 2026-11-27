/**
 * Pedido do dono da clínica (15/10), em duas frases:
 *
 *   1. "Clicar na agenda em algum horário e cadastrar um atendimento" — bloco
 *      vazio, mesmo sem horário publicado, abre o MESMO painel de "Novo
 *      agendamento", já no dia e na meia hora clicados e, com uma pessoa só no
 *      filtro, com ela.
 *   2. A fileira de profissionais (27/11/2026): só quem tem atendimento na semana, uma pessoa por vez, "Todos" zera, e a escolha volta no próximo acesso.
 *
 * A tela inteira é montada (como em `agenda-tipo-da-grade-sobrevive-ao-reload`)
 * porque o que se mede é a LIGAÇÃO: filtro → horários pedidos → clique → painel
 * → POST. O painel vira um dublê que só mostra as props que recebeu.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AgendaClient } from "@/app/app/agenda/_client";
import { FiltroDePessoas } from "@/components/agenda/FiltroDePessoas";
import { GradeDaAgenda, type InteracaoDaGrade } from "@/components/agenda/GradeDaAgenda";

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
    push: vi.fn(),
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
/** Ligado, todo período pedido está CARREGANDO: o hook devolve `data` vazio, como o React Query. */
const periodo = vi.hoisted(() => ({ carregando: false }));
// O canal ao vivo tem teste próprio (`agenda-ao-vivo.test.tsx`); aqui não há Supabase.
vi.mock("@/hooks/agenda/useAgendaAoVivo", () => ({ useAgendaAoVivo: () => ({}) }));
vi.mock("@/hooks/agenda/useAgendamentos", () => ({
  useAgendamentos: () =>
    periodo.carregando
      ? { data: undefined, isError: false, isLoading: true }
      : { data: compromissos, isError: false, isLoading: false },
}));
const marcar = vi.hoisted(() => vi.fn(async (_corpo: Record<string, unknown>) => ({})));
vi.mock("@/hooks/agenda/useMarcarAgendamento", () => ({
  useMarcarAgendamento: () => ({ mutateAsync: marcar, isPending: false }),
}));
vi.mock("@/hooks/agenda/useRemarcarAgendamento", () => ({
  useRemarcarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCancelarAgendamento: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegistrarDesfecho: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

/** O painel real tem calendário e rede; aqui só importa o que ele RECEBEU. */
vi.mock("@/components/agenda/PainelDeMarcacao", () => ({
  PainelDeMarcacao: (props: {
    horarioInicial?: { instante: string; rotulo: string };
    responsavel: { nome: string };
    onConfirmar?: (instante: string) => unknown;
  }) => (
    <div
      data-testid="painel-dublê"
      data-instante={props.horarioInicial?.instante ?? ""}
      data-rotulo={props.horarioInicial?.rotulo ?? ""}
      data-responsavel={props.responsavel.nome}
    >
      <button type="button" onClick={() => props.onConfirmar?.(props.horarioInicial!.instante)}>
        confirmar
      </button>
    </div>
  ),
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
    onConfirmar: (m: {
      instante: string;
      endereco: string;
      observacao: string;
      quemConverteu: { kind: "user"; userId: string } | { kind: "ai" };
    }) => unknown;
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
          props.onConfirmar({
            instante: props.horarioInicial!.instante,
            endereco: "",
            observacao: "",
            // O modal de verdade sempre manda quem converteu (padrão: quem marca).
            quemConverteu: { kind: "user", userId: "u-recepcao" },
          })
        }
      >
        confirmar
      </button>
    </div>
  ),
}));

const TIPOS = [
  { id: "tipo-1", nome: "Consulta", duracaoMin: 30, donoId: "p-ana", localKind: null, localDetalhes: null, exigePaciente: false },
];
const USUARIO = "u-recepcao";
const CHAVE = `agenda.pessoas.v1:${USUARIO}`;
/** Uma terça bem no futuro: nenhum bloco da semana é "passado" no relógio real. */
const HOJE = "2030-01-15";
const QUARTA = "2030-01-16";

function montar() {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <AgendaClient
        fusoDaAgenda="America/Sao_Paulo"
        fusoDeApresentacao="America/Sao_Paulo"
        hojeNaOrganizacao={HOJE}
        googleConfigurado={false}
        faltaNoGoogle={[]}
        tiposIniciais={TIPOS}
        agendamentosIniciais={[]}
        usuarioId={USUARIO}
        podeMarcar
      />
    </QueryClientProvider>,
  );
}

function compromisso(id: string, dono: string, hora: string) {
  return {
    id,
    titulo: `Consulta ${id}`,
    responsavelId: dono,
    comeca: `${QUARTA}T${hora}:00-03:00`,
    termina: `${QUARTA}T${hora.slice(0, 3)}30:00-03:00`,
    origem: "ui",
    situacao: "scheduled",
  };
}

const avatar = (id: string) => screen.getByTestId(`botao-pessoa-${id}`);
const ultimoPedidoDaGrade = () => pedidos.filter((p) => p !== null).at(-1);

beforeEach(() => {
  window.history.replaceState(null, "", "/app/agenda");
  window.localStorage.clear();
  pedidos.length = 0;
  compromissos.length = 0;
  periodo.carregando = false;
  marcar.mockClear();
});
afterEach(cleanup);

describe("clicar num horário vazio abre o Novo agendamento já preenchido", () => {
  it("dia e meia hora do bloco, e a pessoa selecionada no filtro vira a dona", async () => {
    // A fileira só mostra quem TEM atendimento na semana (27/11/2026).
    compromissos.push(compromisso("c-bia", "p-bia", "16:00"));
    montar();
    fireEvent.click(avatar("p-bia"));
    // A dica "Horários livres de" segue a seleção de UMA pessoa.
    expect(ultimoPedidoDaGrade()?.owner_user_id).toBe("p-bia");

    const bloco = screen.getByTestId(`bloco-${QUARTA}-14:30`);
    expect(bloco).toBeEnabled();
    expect(bloco).toHaveAttribute("data-encaixe", "true");
    expect(bloco).toHaveAttribute("aria-label", "Marcar 16/01 às 14:30");
    fireEvent.click(bloco);

    const painel = await screen.findByTestId("painel-dublê");
    // 14:30 em São Paulo: o começo da célula, nunca o minuto do ponteiro.
    expect(painel).toHaveAttribute("data-instante", new Date(`${QUARTA}T14:30:00-03:00`).toISOString());
    expect(painel).toHaveAttribute("data-rotulo", "14:30");
    expect(painel).toHaveAttribute("data-profissional", "p-bia");
    // O procedimento da grade é da Ana: a Bia não o atende, e ele NÃO vem escolhido
    // (pedido do dono da clínica, 20/11 — o modal só oferece os dela, e a rota
    // recusaria `agenda_procedimento_de_outro_profissional`). A recepção escolhe.
    expect(painel).toHaveAttribute("data-tipo", "");
  });

  it("sem pessoa única no filtro, o profissional é o dono do tipo, e o POST o leva explícito", async () => {
    montar();
    expect(ultimoPedidoDaGrade()?.owner_user_id).toBeUndefined();

    fireEvent.click(screen.getByTestId(`bloco-${QUARTA}-09:00`));
    const painel = await screen.findByTestId("painel-dublê");
    // O modal mostra o profissional, então a marcação vai para QUEM ele mostra:
    // o mesmo dono que a rota resolveria pelo tipo, agora escrito no pedido.
    expect(painel).toHaveAttribute("data-profissional", "p-ana");
    fireEvent.click(screen.getByRole("button", { name: "confirmar" }));
    expect(marcar.mock.calls[0]![0]).toHaveProperty("owner_user_id", "p-ana");
  });

  it("horário com compromisso em cima não abre marcação nova", () => {
    compromissos.push(compromisso("c1", "p-ana", "10:00"));
    montar();
    expect(screen.getByTestId(`bloco-${QUARTA}-10:00`)).toBeDisabled();
  });
});

describe("o bloco vazio pelo teclado", () => {
  const DIA = "2030-01-16";
  function grade(inter: Partial<InteracaoDaGrade>) {
    const onMarcarEm = vi.fn();
    render(
      <GradeDaAgenda
        visao="dia"
        ancora={new Date(`${DIA}T12:00:00`)}
        agora={new Date(`${DIA}T08:10:00-03:00`)}
        fuso="America/Sao_Paulo"
        pessoas={PESSOAS}
        agendamentos={[]}
        interacao={{ horariosPorDia: {}, motivo: "sem-vaga", duracaoMin: 30, onMarcarEm, ...inter }}
      />,
    );
    return onMarcarEm;
  }

  it("Enter e Espaço marcam no bloco focado", async () => {
    const onMarcarEm = grade({ encaixe: true });
    const bloco = screen.getByTestId(`bloco-${DIA}-15:00`);
    bloco.focus();
    expect(bloco).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onMarcarEm).toHaveBeenCalledTimes(2);
    expect(onMarcarEm).toHaveBeenCalledWith(new Date(`${DIA}T15:00:00-03:00`).toISOString());
  });

  it("o passado segue recusado, como sempre foi", () => {
    grade({ encaixe: true });
    // 07:30–08:00 já acabou às 08:10; 08:00–08:30 ainda não, e segue a regra de antes.
    expect(screen.getByTestId(`bloco-${DIA}-07:30`)).toBeDisabled();
    expect(screen.getByTestId(`bloco-${DIA}-07:30`)).toHaveAttribute("title", "este horário já passou");
  });

  it("sem jornada publicada, nem o encaixe abre (a rota recusaria)", () => {
    grade({ encaixe: true, motivo: "sem-jornada" });
    expect(screen.getByTestId(`bloco-${DIA}-15:00`)).toBeDisabled();
  });

  it("sem `encaixe`, só o publicado é clicável (a vitrine e quem só lê)", () => {
    grade({});
    expect(screen.getByTestId(`bloco-${DIA}-15:00`)).toBeDisabled();
  });
});

describe("fileira: uma pessoa de cada vez (27/11/2026)", () => {
  const tres = () =>
    compromissos.push(
      compromisso("c-ana", "p-ana", "09:00"),
      compromisso("c-bia", "p-bia", "11:00"),
      compromisso("c-caio", "p-caio", "13:00"),
    );
  const visiveis = () =>
    ["c-ana", "c-bia", "c-caio"].filter((id) => screen.queryByTestId(`agendamento-${id}`));

  it("escolhe uma pessoa; clicar de novo ou em Todos volta a todos", () => {
    tres();
    montar();
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(avatar("p-ana"));
    expect(visiveis()).toEqual(["c-ana"]);
    fireEvent.click(avatar("p-caio"));
    expect(visiveis()).toEqual(["c-caio"]);
    expect(avatar("p-ana")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(avatar("p-caio"));
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);

    fireEvent.click(avatar("p-bia"));
    fireEvent.click(screen.getByTestId("botao-todos"));
    expect(visiveis()).toEqual(["c-ana", "c-bia", "c-caio"]);
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");
  });

  it("só quem tem atendimento na semana entra na fileira", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    expect(avatar("p-ana")).toBeInTheDocument();
    expect(screen.queryByTestId("botao-pessoa-p-bia")).toBeNull();
  });

  it("a escolhida sem nada na semana continua na fileira, marcada, e Todos desfaz", () => {
    // Escolheu a Bia numa semana em que ela atendia; a semana carregada agora
    // só tem a Ana. Se ela sumisse da fileira, a grade ficaria filtrada por
    // alguém invisível, sem botão para desfazer.
    window.localStorage.setItem(CHAVE, JSON.stringify(["p-bia"]));
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    expect(avatar("p-bia")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "p-bia");
    expect(visiveis()).toEqual([]);

    fireEvent.click(screen.getByTestId("botao-todos"));
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
    expect(visiveis()).toEqual(["c-ana"]);
    // Sem a escolha, ela sai da fileira: não tem atendimento na semana.
    expect(screen.queryByTestId("botao-pessoa-p-bia")).toBeNull();
  });

  it("a escolha volta no próximo acesso; uma antiga de várias vale pela primeira; id invisível cai fora", () => {
    tres();
    const primeira = montar();
    fireEvent.click(avatar("p-bia"));
    expect(JSON.parse(window.localStorage.getItem(CHAVE)!)).toEqual(["p-bia"]);
    primeira.unmount();

    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "p-bia");
    cleanup();

    // Gravada quando o filtro era múltiplo.
    window.localStorage.setItem(CHAVE, JSON.stringify(["p-caio", "p-bia"]));
    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "p-caio");
    cleanup();

    window.localStorage.setItem(CHAVE, JSON.stringify(["p-sumiu"]));
    montar();
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
  });

  it("armazenamento bloqueado não derruba a tela", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    const ler = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const gravar = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    montar();
    fireEvent.click(avatar("p-ana"));
    expect(avatar("p-ana")).toHaveAttribute("aria-pressed", "true");
    ler.mockRestore();
    gravar.mockRestore();
  });

  it("ninguém com atendimento: a fileira some", () => {
    render(<FiltroDePessoas pessoas={[]} selecionadas={[]} onMudar={vi.fn()} />);
    expect(screen.queryByTestId("filtro-de-pessoas")).toBeNull();
  });

  it("a fileira não pisca enquanto o período novo carrega", () => {
    // Com "Todos", o período novo chega vazio até a resposta: a fileira sumia
    // e o topo inteiro pulava (no celular, linhas de 44 px).
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    expect(avatar("p-ana")).toBeInTheDocument();

    periodo.carregando = true;
    fireEvent.click(screen.getByTestId("periodo-seguinte"));
    expect(screen.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
    expect(avatar("p-ana")).toBeInTheDocument();
  });

  it("desfazer a escolhida que some da fileira leva o foco ao Todos, não ao <body>", () => {
    // O caso da escolhida sem nada na semana: clicar nela de novo desfaz, ela
    // sai da fileira, e o foco do teclado não pode cair no vazio.
    window.localStorage.setItem(CHAVE, JSON.stringify(["p-bia"]));
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    avatar("p-bia").focus();
    fireEvent.click(avatar("p-bia"));
    expect(screen.queryByTestId("botao-pessoa-p-bia")).toBeNull();
    expect(screen.getByTestId("botao-todos")).toHaveFocus();
  });

  it("desfazer quem segue na fileira não rouba o foco", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    fireEvent.click(avatar("p-ana"));
    avatar("p-ana").focus();
    fireEvent.click(avatar("p-ana"));
    expect(screen.getByTestId("botao-todos")).toHaveAttribute("aria-pressed", "true");
    expect(avatar("p-ana")).toHaveFocus();
  });
});

describe("topo numa linha só (decisão 7 do André, 27/11/2026)", () => {
  it("período, Hoje, visões e Novo agendamento no topo; a fileira de profissionais logo abaixo", () => {
    compromissos.push(compromisso("c-ana", "p-ana", "09:00"));
    montar();
    const topo = screen.getByTestId("topo-da-agenda");
    for (const id of ["periodo-anterior", "periodo-seguinte", "periodo", "alternador-de-visao", "novo-agendamento"]) {
      expect(topo.contains(screen.getByTestId(id)), id).toBe(true);
    }
    expect(within(topo).getByRole("button", { name: "Hoje" })).toBeInTheDocument();
    const fileira = screen.getByTestId("filtro-de-pessoas");
    expect(topo.contains(fileira)).toBe(false);
    expect(screen.getByTestId("linha-de-filtros").contains(fileira)).toBe(true);
    expect(topo.compareDocumentPosition(fileira) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
