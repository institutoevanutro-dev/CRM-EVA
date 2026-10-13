/**
 * QUADRO OU CALENDÁRIO: a visão do funil, e o que NÃO pode mudar por causa dela.
 *
 *   1. Sem escolher nada, a tela é o quadro de sempre.
 *   2. O calendário recebe EXATAMENTE a lista que o quadro recebe (a mesma
 *      resposta do servidor, os mesmos filtros). Ele não busca nada, então não
 *      tem como mostrar a alguém um negócio que o quadro esconde.
 *   3. A escolha sobrevive à recarga (guardada no navegador), e um navegador
 *      que recusa `localStorage` não quebra a tela.
 *   4. O seletor de funil continua no cabeçalho nas duas visões.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelinePageClient } from "@/app/app/pipelines/[id]/_client";
import { gravarPreferencia, lerPreferencia, PREFERENCIA_PADRAO } from "@/lib/kanban/visao-do-funil";

window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const busca = vi.hoisted(() => ({ atual: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/pipelines/p-1",
  useSearchParams: () => new URLSearchParams(busca.atual),
}));

const lead = (id: string, owner_user_id: string | null) => ({
  id,
  title: id,
  description: null,
  status: "open",
  tags: [],
  owner_user_id,
  owner_agent_id: null,
  value_cents: null,
  expected_close_date: null,
  custom_fields: {},
  created_at: "2026-03-10T15:00:00+00:00",
  updated_at: "2026-03-10T15:00:00+00:00",
});
/** O que o servidor devolveu a ESTA pessoa: a RLS já passou por aqui. */
const DO_SERVIDOR = [lead("l1", "u-1"), lead("l2", "u-2"), lead("l3", null)];

vi.mock("@/hooks/kanban/useBoard", () => ({
  useFechadosAntigos: () => ({ data: undefined, isLoading: false }),
  useBoard: () => ({
    data: {
      pipeline: { id: "p-1", name: "Vendas", vocabulary: null, settings: null },
      stages: [],
      leads: DO_SERVIDOR,
    },
    isLoading: false,
    error: null,
    pulses: new Map(),
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0, ultimaVerificacao: null },
  }),
}));
vi.mock("@/hooks/kanban/useBulkAction", () => ({
  useBulkAction: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u-1" }),
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
  usePermission: () => false,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
// As duas visões viram um espelho do que RECEBEM: é isso que se compara.
vi.mock("@/components/kanban/KanbanBoard", () => ({
  KanbanBoard: ({ leads }: { leads: Array<{ id: string }> }) => (
    <div data-testid="quadro">{leads.map((l) => l.id).join(",")}</div>
  ),
}));
vi.mock("@/components/kanban/CalendarioDoFunil", () => ({
  CalendarioDoFunil: (p: {
    leads: Array<{ id: string }>;
    fuso: string;
    periodo: string;
    campoEscolhido: string | null;
    aoMudar: (parcial: { periodo?: "mes" | "semana"; campo?: string | null }) => void;
  }) => (
    <div data-testid="calendario" data-fuso={p.fuso} data-periodo={p.periodo} data-campo={p.campoEscolhido ?? ""}>
      {p.leads.map((l) => l.id).join(",")}
      <button onClick={() => p.aoMudar({ periodo: "semana", campo: "@expected_close_date" })}>escolher</button>
    </div>
  ),
}));

const FUNIS = [
  { id: "p-1", name: "Vendas" },
  { id: "p-2", name: "Retornos" },
];
const tela = (pipelineId = "p-1") => (
  <PipelinePageClient pipelineId={pipelineId} initialName="Vendas" funis={FUNIS} fuso="America/Manaus" />
);

beforeEach(() => {
  busca.atual = "";
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("sem escolher nada", () => {
  it("a tela é o quadro, com a lista do servidor, e nada é gravado", () => {
    render(tela());
    expect(screen.getByTestId("quadro")).toHaveTextContent("l1,l2,l3");
    expect(screen.queryByTestId("calendario")).toBeNull();
    expect(screen.getByTestId("visao-quadro")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("visao-calendario")).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.length).toBe(0);
  });
});

describe("trocar de visão", () => {
  it("o calendário recebe a mesma lista do quadro e o fuso da organização; Quadro volta", async () => {
    render(tela());
    const noQuadro = screen.getByTestId("quadro").textContent;

    await userEvent.click(screen.getByRole("button", { name: "Calendário" }));
    const calendario = screen.getByTestId("calendario");
    expect(calendario.firstChild?.textContent).toBe(noQuadro);
    expect(calendario).toHaveAttribute("data-fuso", "America/Manaus");
    expect(screen.queryByTestId("quadro")).toBeNull();
    // O seletor de funil continua no cabeçalho.
    expect(screen.getByRole("combobox", { name: /Trocar de funil/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Quadro" }));
    expect(screen.getByTestId("quadro")).toHaveTextContent("l1,l2,l3");
    expect(screen.queryByTestId("calendario")).toBeNull();
  });

  it("o filtro da barra corta as duas visões do mesmo jeito", async () => {
    busca.atual = "owner=u-2";
    render(tela());
    expect(screen.getByTestId("quadro")).toHaveTextContent("l2");
    await userEvent.click(screen.getByTestId("visao-calendario"));
    expect(screen.getByTestId("calendario").firstChild?.textContent).toBe("l2");

    cleanup();
    busca.atual = "owner=unassigned";
    render(tela());
    // A visão ficou guardada: já abre no calendário.
    expect(screen.getByTestId("calendario").firstChild?.textContent).toBe("l3");
  });
});

describe("a escolha sobrevive à recarga", () => {
  it("visão, período e campo voltam; o campo é por funil, a visão vale para todos", async () => {
    render(tela());
    await userEvent.click(screen.getByTestId("visao-calendario"));
    await userEvent.click(screen.getByRole("button", { name: "escolher" }));
    cleanup();

    render(tela());
    const calendario = screen.getByTestId("calendario");
    expect(calendario).toHaveAttribute("data-periodo", "semana");
    expect(calendario).toHaveAttribute("data-campo", "@expected_close_date");
    cleanup();

    // Outro funil: continua no calendário (e na semana), mas o campo é o dele.
    render(tela("p-2"));
    const doOutro = screen.getByTestId("calendario");
    expect(doOutro).toHaveAttribute("data-periodo", "semana");
    expect(doOutro).toHaveAttribute("data-campo", "");
  });

  it("navegador que recusa localStorage: a troca funciona nesta visita e nada lança", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cheio", "QuotaExceededError");
    });
    render(tela());
    expect(screen.getByTestId("quadro")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("visao-calendario"));
    expect(screen.getByTestId("calendario")).toBeInTheDocument();
  });

  it("lixo guardado vira o padrão, sem derrubar a tela", () => {
    for (const lixo of ["{", "null", '"texto"', "[]", '{"visao":"outra","periodo":7,"campos":{"p-1":{"campo":3}}}']) {
      window.localStorage.setItem("funil.visao.v1", lixo);
      expect(lerPreferencia("p-1")).toEqual(PREFERENCIA_PADRAO);
    }
  });

  it("gravar um funil não apaga o campo guardado de outro", () => {
    gravarPreferencia("p-1", { visao: "calendario", periodo: "mes", campo: "data_inicio", campoFim: null });
    gravarPreferencia("p-2", { visao: "calendario", periodo: "semana", campo: "@created_at", campoFim: "data_fim" });
    expect(lerPreferencia("p-1")).toEqual({
      visao: "calendario",
      periodo: "semana",
      campo: "data_inicio",
      campoFim: null,
    });
    expect(lerPreferencia("p-2").campoFim).toBe("data_fim");
  });
});
