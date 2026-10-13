/**
 * A VISÃO CALENDÁRIO DO FUNIL MOSTRA O NEGÓCIO NO DIA DA SUA DATA.
 *
 * Porte dos testes do upstream melgarafael/DeskcommCRM#2790 (@webtecnica), com o
 * que este fork acrescentou: o dia é o da ORGANIZAÇÃO, quem não tem data é
 * LISTADO (não some), e o dia cheio diz quantos mostra de quantos.
 *
 * O relógio é fixo (`agora`), e o fuso é o da organização: o teste dá a mesma
 * resposta em qualquer máquina e em qualquer dia do mês.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarioDoFunil, TETO_DA_LISTA } from "@/components/kanban/CalendarioDoFunil";
import { CAMPO_CRIACAO } from "@/lib/kanban/calendario-do-funil";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { PeriodoDoCalendario } from "@/lib/kanban/visao-do-funil";
import type { Lead } from "@/lib/types/leads";

// Polyfills que o Radix Select exige e o jsdom não tem (mesmo padrão de
// app/app/pipelines/[id]/trocar-funil.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

// A ficha tem testes próprios; aqui só importa que o clique ABRE ela, com o
// negócio certo.
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: ({ lead }: { lead: Lead | null }) =>
    lead ? <div data-testid="ficha-aberta">{lead.title}</div> : null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

afterEach(() => cleanup());

const SP = "America/Sao_Paulo";
/** Terça, 17/03/2026, 12:00 em São Paulo. */
const AGORA = new Date("2026-03-17T15:00:00Z");

const FUNIL: Pipeline = {
  id: "p-1",
  organization_id: "org-1",
  name: "Avaliações",
  slug: "avaliacoes",
  description: null,
  is_default: true,
  is_archived: false,
  position: 1,
  vocabulary: {},
  settings: {
    fields: [
      { key: "data_inicio", label: "Data de início", type: "date" },
      { key: "data_fim", label: "Data de fim", type: "date" },
    ],
  },
};

const ETAPAS: Stage[] = [
  {
    id: "etapa-1",
    organization_id: "org-1",
    pipeline_id: "p-1",
    name: "Proposta",
    slug: "proposta",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  },
];

function negocio(id: string, title: string, parcial: Partial<Lead> = {}): Lead {
  return {
    id,
    organization_id: "org-1",
    pipeline_id: "p-1",
    stage_id: "etapa-1",
    contact_id: null,
    title,
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    stage_changed_at: null,
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: "2026-01-05T15:00:00+00:00",
    updated_at: "2026-01-05T15:00:00+00:00",
    created_by_user_id: null,
    ...parcial,
  };
}

const comInicio = (id: string, title: string, dia: string) =>
  negocio(id, title, { custom_fields: { data_inicio: dia } });

/** A tela de verdade guarda a escolha em quem chama; aqui um estado faz esse papel. */
function Tela({
  leads,
  fuso = SP,
  funil = FUNIL,
  inicial = {},
}: {
  leads: Lead[];
  fuso?: string;
  funil?: Pipeline;
  inicial?: { periodo?: PeriodoDoCalendario; campo?: string | null; campoFim?: string | null };
}) {
  const [escolha, setEscolha] = useState({
    periodo: "mes" as PeriodoDoCalendario,
    campo: null as string | null,
    campoFim: null as string | null,
    ...inicial,
  });
  return (
    <CalendarioDoFunil
      pipelineId={funil.id}
      pipeline={funil}
      stages={ETAPAS}
      leads={leads}
      fuso={fuso}
      periodo={escolha.periodo}
      campoEscolhido={escolha.campo}
      campoFimEscolhido={escolha.campoFim}
      aoMudar={(parcial) => setEscolha((atual) => ({ ...atual, ...parcial }))}
      agora={AGORA}
    />
  );
}

const celula = (dia: string) => screen.getByTestId(`calendario-dia-${dia}`);

describe("a visão de mês", () => {
  it("abre no mês de hoje e põe o negócio na célula do dia certo", () => {
    render(<Tela leads={[comInicio("l1", "Avaliação da Silva", "2026-03-12")]} />);

    expect(screen.getByTestId("calendario-periodo")).toHaveTextContent("março de 2026");
    expect(within(celula("2026-03-12")).getByText("Avaliação da Silva")).toBeInTheDocument();
    expect(within(celula("2026-03-17")).getByText("17")).toHaveAttribute("aria-current", "date");
    // Março de 2026: 31 dias, nem um a mais.
    expect(screen.getAllByTestId(/^calendario-dia-/)).toHaveLength(31);
  });

  it("o negócio de outro mês só aparece depois de navegar até ele, e Hoje volta", async () => {
    render(<Tela leads={[comInicio("l1", "Retorno de abril", "2026-04-02")]} />);
    expect(screen.queryByText("Retorno de abril")).not.toBeInTheDocument();
    // Mês sem ninguém: a tela diz, em vez de mostrar uma grade muda.
    expect(screen.getByTestId("calendario-vazio")).toHaveTextContent(
      "Nenhum negócio com este campo de data neste período.",
    );

    await userEvent.click(screen.getByRole("button", { name: "Próximo mês" }));
    expect(screen.getByTestId("calendario-periodo")).toHaveTextContent("abril de 2026");
    expect(within(celula("2026-04-02")).getByText("Retorno de abril")).toBeInTheDocument();
    expect(screen.queryByTestId("calendario-vazio")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    await userEvent.click(screen.getByRole("button", { name: "Mês anterior" }));
    expect(screen.getByTestId("calendario-periodo")).toHaveTextContent("fevereiro de 2026");

    await userEvent.click(screen.getByRole("button", { name: "Hoje" }));
    expect(screen.getByTestId("calendario-periodo")).toHaveTextContent("março de 2026");
  });
});

describe("quem não tem data", () => {
  it("não ganha um dia inventado, mas é contado e listado", async () => {
    render(
      <Tela
        leads={[
          comInicio("l1", "Avaliação da Silva", "2026-03-12"),
          negocio("l2", "Sem data marcada"),
          comInicio("l3", "Data que não existe", "2026-02-30"),
        ]}
      />,
    );

    expect(screen.queryByText("Sem data marcada")).not.toBeInTheDocument();
    const botao = screen.getByTestId("calendario-sem-data");
    expect(botao).toHaveTextContent("2 sem data neste campo");
    expect(botao).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(botao);
    const lista = screen.getByRole("region", { name: "Negócios sem data neste campo" });
    expect(within(lista).getByText("Sem data marcada")).toBeInTheDocument();
    expect(within(lista).getByText("Data que não existe")).toBeInTheDocument();
    expect(within(lista).queryByText("Avaliação da Silva")).not.toBeInTheDocument();

    await userEvent.click(within(lista).getByText("Sem data marcada"));
    expect(screen.getByTestId("ficha-aberta")).toHaveTextContent("Sem data marcada");
  });

  it("ninguém com o campo preenchido: diz isso, e ainda lista todos", () => {
    render(<Tela leads={[negocio("l1", "Um"), negocio("l2", "Dois")]} />);
    expect(screen.getByTestId("calendario-vazio")).toHaveTextContent("Nenhum negócio com este campo de data.");
    expect(screen.getByTestId("calendario-sem-data")).toHaveTextContent("2 sem data neste campo");
  });
});

describe("o dia é o da organização", () => {
  // 15/03 23:30 em São Paulo = 16/03 02:30 UTC.
  const tarde = negocio("l1", "Chegou às 23:30", { created_at: "2026-03-16T02:30:00+00:00" });

  it("criado às 23:30 em São Paulo fica no dia 15, não no 16", () => {
    render(<Tela leads={[tarde]} inicial={{ campo: CAMPO_CRIACAO }} />);
    expect(within(celula("2026-03-15")).getByText("Chegou às 23:30")).toBeInTheDocument();
    expect(within(celula("2026-03-16")).queryByText("Chegou às 23:30")).not.toBeInTheDocument();
  });

  it("a mesma lista, numa organização de Tóquio, cai no dia 16, e hoje é o dia de lá", () => {
    render(<Tela leads={[tarde]} fuso="Asia/Tokyo" inicial={{ campo: CAMPO_CRIACAO }} />);
    expect(within(celula("2026-03-16")).getByText("Chegou às 23:30")).toBeInTheDocument();
    // 17/03 15:00 UTC já é dia 18 em Tóquio.
    expect(within(celula("2026-03-18")).getByText("18")).toHaveAttribute("aria-current", "date");
  });
});

describe("a visão de semana", () => {
  it("mostra só os 7 dias, de domingo a sábado", () => {
    render(
      <Tela
        inicial={{ periodo: "semana" }}
        leads={[
          comInicio("l1", "Hoje mesmo", "2026-03-17"),
          comInicio("l2", "Semana que vem", "2026-03-24"),
          negocio("l3", "Sem data marcada"),
        ]}
      />,
    );

    expect(screen.getAllByTestId(/^calendario-dia-/).map((el) => el.dataset.testid)).toEqual([
      "calendario-dia-2026-03-15",
      "calendario-dia-2026-03-16",
      "calendario-dia-2026-03-17",
      "calendario-dia-2026-03-18",
      "calendario-dia-2026-03-19",
      "calendario-dia-2026-03-20",
      "calendario-dia-2026-03-21",
    ]);
    expect(within(celula("2026-03-17")).getByText("Hoje mesmo")).toBeInTheDocument();
    expect(screen.queryByText("Semana que vem")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendario-semana")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("calendario-mes")).toHaveAttribute("aria-pressed", "false");
  });

  it("anda de 7 em 7 dias, e trocar para Mês cai no mês daquela semana", async () => {
    render(
      <Tela inicial={{ periodo: "semana" }} leads={[comInicio("l2", "Semana que vem", "2026-03-24")]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Próxima semana" }));
    expect(within(celula("2026-03-24")).getByText("Semana que vem")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Próxima semana" }));
    await userEvent.click(screen.getByRole("button", { name: "Próxima semana" }));
    // Semana de 05/04 a 11/04.
    expect(screen.getByTestId("calendario-dia-2026-04-05")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("calendario-mes"));
    expect(screen.getByTestId("calendario-periodo")).toHaveTextContent("abril de 2026");
  });
});

describe("a escolha do campo de data", () => {
  it("oferece os campos de data do funil e os dois nativos; trocar troca quem aparece", async () => {
    render(
      <Tela
        leads={[
          comInicio("l1", "Tem data de início", "2026-03-12"),
          negocio("l2", "Tem data de fim", { custom_fields: { data_fim: "2026-03-12" } }),
          negocio("l3", "Tem previsão", { expected_close_date: "2026-03-20" }),
        ]}
      />,
    );

    // Padrão: o primeiro campo de data do funil.
    expect(screen.getByText("Tem data de início")).toBeInTheDocument();
    expect(screen.queryByText("Tem data de fim")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Data de início",
      "Data de fim",
      "Fechamento previsto",
      "Criado em",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "Data de fim" }));
    expect(screen.getByText("Tem data de fim")).toBeInTheDocument();
    expect(screen.queryByText("Tem data de início")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("combobox", { name: "Campo de data" }));
    await userEvent.click(await screen.findByRole("option", { name: "Fechamento previsto" }));
    expect(within(celula("2026-03-20")).getByText("Tem previsão")).toBeInTheDocument();
  });

  it("funil sem campo de data abre na data de criação, em vez de uma tela vazia", () => {
    render(
      <Tela
        funil={{ ...FUNIL, settings: {} }}
        leads={[negocio("l1", "Chegou dia 10", { created_at: "2026-03-10T15:00:00+00:00" })]}
      />,
    );
    expect(within(celula("2026-03-10")).getByText("Chegou dia 10")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Campo de data" })).toHaveTextContent("Criado em");
  });

  it("escolha guardada de um campo que não existe mais cai no padrão", () => {
    render(
      <Tela
        inicial={{ campo: "campo_apagado", campoFim: "outro_apagado" }}
        leads={[comInicio("l1", "Avaliação da Silva", "2026-03-12")]}
      />,
    );
    expect(within(celula("2026-03-12")).getByText("Avaliação da Silva")).toBeInTheDocument();
  });

  it("com um segundo campo, o negócio ocupa o intervalo", () => {
    render(
      <Tela
        inicial={{ campoFim: "data_fim" }}
        leads={[
          negocio("l1", "Tratamento", { custom_fields: { data_inicio: "2026-03-10", data_fim: "2026-03-12" } }),
        ]}
      />,
    );
    for (const dia of ["2026-03-10", "2026-03-11", "2026-03-12"]) {
      expect(within(celula(dia)).getByText("Tratamento")).toBeInTheDocument();
    }
    expect(within(celula("2026-03-13")).queryByText("Tratamento")).not.toBeInTheDocument();
  });
});

describe("dia cheio", () => {
  const doze = Array.from({ length: 12 }, (_, i) => comInicio(`l${i}`, `Negócio ${i + 1}`, "2026-03-12"));

  it("mostra 3, diz 3 de 12, e abre a lista com os 12", async () => {
    render(<Tela leads={doze} />);

    const dia = celula("2026-03-12");
    expect(within(dia).getAllByTestId(/^calendario-negocio-/)).toHaveLength(3);
    const verTodos = within(dia).getByTestId("calendario-ver-todos-2026-03-12");
    expect(verTodos).toHaveTextContent("3 de 12 · ver todos");

    await userEvent.click(verTodos);
    const lista = screen.getByTestId("calendario-lista");
    expect(within(lista).getAllByRole("button")).toHaveLength(12);
    expect(within(lista).getByRole("heading")).toHaveTextContent("quinta-feira, 12 de março · 12");
    expect(screen.queryByTestId("calendario-lista-teto")).not.toBeInTheDocument();
  });

  it("a contagem do dia (a do celular) tem nome para leitor de tela e abre a mesma lista", async () => {
    render(<Tela leads={doze} />);
    const contagem = screen.getByRole("button", { name: "12 negócios em quinta-feira, 12 de março" });
    expect(contagem).toHaveTextContent("12");
    await userEvent.click(contagem);
    expect(within(screen.getByTestId("calendario-lista")).getAllByRole("button")).toHaveLength(12);
  });

  it("trocar de período fecha a lista aberta", async () => {
    render(<Tela leads={doze} />);
    await userEvent.click(screen.getByTestId("calendario-ver-todos-2026-03-12"));
    expect(screen.getByTestId("calendario-lista")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("calendario-semana"));
    expect(screen.queryByTestId("calendario-lista")).not.toBeInTheDocument();
  });

  it("dia com até 3 não tem 'ver todos'", () => {
    render(<Tela leads={doze.slice(0, 3)} />);
    expect(screen.queryByTestId("calendario-ver-todos-2026-03-12")).not.toBeInTheDocument();
  });

  it("lista com mais que o teto diz quantos mostra de quantos", async () => {
    const muitos = Array.from({ length: TETO_DA_LISTA + 50 }, (_, i) => negocio(`s${i}`, `Sem data ${i}`));
    render(<Tela leads={muitos} />);
    await userEvent.click(screen.getByTestId("calendario-sem-data"));
    const lista = screen.getByTestId("calendario-lista");
    expect(within(lista).getAllByRole("button")).toHaveLength(TETO_DA_LISTA);
    expect(screen.getByTestId("calendario-lista-teto")).toHaveTextContent(
      `Mostrando ${TETO_DA_LISTA} de ${TETO_DA_LISTA + 50}.`,
    );
  });
});

describe("clicar no negócio", () => {
  it("abre a ficha dele", async () => {
    render(<Tela leads={[comInicio("l1", "Avaliação da Silva", "2026-03-12")]} />);
    await userEvent.click(screen.getByTestId("calendario-negocio-l1"));
    expect(screen.getByTestId("ficha-aberta")).toHaveTextContent("Avaliação da Silva");
  });

  it("o negócio é um botão alcançável pelo teclado, com a etapa no título", async () => {
    render(<Tela leads={[comInicio("l1", "Avaliação da Silva", "2026-03-12")]} />);
    const chip = screen.getByRole("button", { name: "Avaliação da Silva" });
    expect(chip).toHaveAttribute("title", "Avaliação da Silva · Proposta");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("ficha-aberta")).toBeInTheDocument();
  });
});
