// components/kanban/LeadDossier.test.tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeadDossier } from "./LeadDossier";
import { CHAVE_DAS_SECOES_RECOLHIDAS } from "./SecaoDoDossie";
import type { Lead } from "@/lib/types/leads";

/**
 * A ORDEM E O RECOLHIMENTO DAS SEÇÕES DO DOSSIÊ (upstream #3181, PR #3232).
 *
 * A ordem era Linha do tempo → Dados do negócio. Com o uso, a linha do tempo
 * cresce e os campos do funil ficam atrás de uma parede de rolagem. O teste mede
 * ORDEM no DOM (`querySelectorAll("[data-secao]")` devolve em ordem de
 * documento), não presença: as duas seções sempre estiveram na tela.
 *
 * As peças de DENTRO das seções e o `LeadTimeline` são marcadores: o objeto
 * aqui é a CASCA do dossiê. O `LeadTimeline` mockado desenha UMA linha por item
 * recebido, que é como o recorte "no máximo três entradas" fica observável.
 *
 * Adaptação ao fork: não há a seção "Contato" do upstream (`ContatoDoNegocio`)
 * nem "Propostas"; as seções recolhíveis são duas.
 */

const linhaDoTempo = vi.hoisted(() => ({ itens: [] as Array<{ id: string; type: string }> }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({ id: "u1", is_platform_admin: false, support: false }),
  useActiveOrg: () => ({ role: "agent" }),
}));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: linhaDoTempo.itens,
    chegouAoVivo: new Set<string>(),
    isLoading: false,
    isError: false,
    realtimeStatus: "connected",
    seguranca: { divergencias: 0 },
  }),
}));

vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => <div data-peca="campos" /> }));
vi.mock("./TarefasDoNegocio", () => ({ TarefasDoNegocio: () => <div data-peca="tarefas" /> }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));
vi.mock("./LeadTimeline", () => ({
  LeadTimeline: ({ itens }: { itens: Array<{ id: string; type: string }> }) => (
    <ul data-peca="linha-do-tempo">
      {itens.map((i) => (
        <li key={i.id} data-entrada={i.id} />
      ))}
    </ul>
  ),
}));

// jsdom não implementa `scrollIntoView`, e o atalho "Editar campos" o chama.
window.HTMLElement.prototype.scrollIntoView ??= () => undefined;

const LEAD = {
  id: "lead-1",
  title: "Avaliação facial",
  contact_id: "contato-1",
  value_cents: 250000,
  currency: "BRL",
  score: null,
  conversa: null,
  owner_kind: null,
  owner_user_id: null,
  owner_agent_id: null,
  owner_agent: null,
} as unknown as Lead;

function montarDossie() {
  return render(
    <LeadDossier
      open
      onOpenChange={() => undefined}
      lead={LEAD}
      pipelineId="funil-1"
      fieldDefs={[]}
      stageName="Novo"
    />,
  );
}

/** Os identificadores das seções, NA ORDEM DO DOM. */
function ordemDasSecoes(): string[] {
  return [...document.querySelectorAll("[data-secao]")].map((n) => n.getAttribute("data-secao")!);
}

function secao(id: string): HTMLElement {
  const no = document.querySelector(`[data-secao="${id}"]`);
  expect(no, `a seção ${id} não está no DOM`).not.toBeNull();
  return no as HTMLElement;
}

function peca(nome: string): Element {
  const no = document.querySelector(`[data-peca="${nome}"]`);
  expect(no, `falta a peça ${nome}`).not.toBeNull();
  return no!;
}

const antes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function entradasVisiveis(): string[] {
  return [...document.querySelectorAll("[data-entrada]")].map((n) => n.getAttribute("data-entrada")!);
}

function seisAtividades() {
  // A rota devolve `performed_at` decrescente: o primeiro item é o mais
  // recente, e é por isso que "as últimas três" é um corte no INÍCIO.
  return ["a6", "a5", "a4", "a3", "a2", "a1"].map((id) => ({ id, type: "stage_changed" }));
}

beforeEach(() => {
  window.localStorage.clear();
  linhaDoTempo.itens = seisAtividades();
});

describe("a ordem das seções do dossiê (#3181)", () => {
  it("⭐ a ordem padrão é Dados do negócio, Tarefas, Linha do tempo", () => {
    montarDossie();

    expect(ordemDasSecoes()).toEqual(["dados-do-negocio", "linha-do-tempo"]);

    // A mesma ordem pelo TEXTO que o atendente lê: o id poderia estar certo com
    // o título trocado de lugar. O primeiro `<span>` do cabeçalho é o título; o
    // segundo é o sinal `+`/`−`.
    const titulos = ordemDasSecoes().map((id) => secao(id).querySelector("h3 button span")?.textContent);
    expect(titulos).toEqual(["Dados do negócio", "Linha do tempo"]);

    // Os campos vêm ANTES de a linha do tempo começar (era o que a ordem antiga
    // não entregava), e as tarefas seguem entre os dois.
    expect(antes(peca("campos"), peca("tarefas"))).toBe(true);
    expect(antes(peca("tarefas"), peca("linha-do-tempo"))).toBe(true);
  });

  it("as seções nascem ABERTAS: sem preferência salva, ninguém esconde conteúdo", () => {
    montarDossie();

    for (const id of ["dados-do-negocio", "linha-do-tempo"]) {
      expect(secao(id).getAttribute("data-recolhida")).toBe("nao");
      const cabecalho = within(secao(id)).getByRole("button");
      expect(cabecalho, `a seção ${id} não se anuncia aberta`).toHaveAttribute("aria-expanded", "true");
    }
    expect(entradasVisiveis()).toHaveLength(6);
  });
});

describe("a linha do tempo recolhida (#3181)", () => {
  it("⭐ recolhida: no máximo 3 entradas (as mais recentes) e o 'ver tudo'", async () => {
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));

    montarDossie();

    await waitFor(() => expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim"));

    expect(entradasVisiveis()).toEqual(["a6", "a5", "a4"]);
    expect(within(secao("linha-do-tempo")).getByRole("button", { name: "Ver tudo" })).toBeInTheDocument();
    expect(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("aberta: TODAS as entradas e nenhum 'ver tudo'", () => {
    montarDossie();

    expect(entradasVisiveis()).toHaveLength(6);
    expect(screen.queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });

  it("o 'ver tudo' abre a seção com a lista completa", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));
    montarDossie();

    const verTudo = await within(secao("linha-do-tempo")).findByRole("button", { name: "Ver tudo" });
    await user.click(verTudo);

    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("nao");
    expect(entradasVisiveis()).toHaveLength(6);
  });

  it("linha do tempo curta não inventa um 'ver tudo' vazio", async () => {
    linhaDoTempo.itens = [{ id: "a1", type: "lead_created" }];
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["linha-do-tempo"]));
    montarDossie();

    await waitFor(() => expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim"));
    expect(entradasVisiveis()).toEqual(["a1"]);
    expect(screen.queryByRole("button", { name: "Ver tudo" })).not.toBeInTheDocument();
  });
});

describe("o estado recolhido é LEMBRADO (#3181)", () => {
  it("⭐ recolher a linha do tempo sobrevive a um segundo dossiê", async () => {
    const user = userEvent.setup();
    const primeiro = montarDossie();

    await user.click(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" }));
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toEqual([
      "linha-do-tempo",
    ]);
    primeiro.unmount();

    montarDossie();
    await waitFor(() => expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim"));
    expect(entradasVisiveis()).toEqual(["a6", "a5", "a4"]);
  });

  it("recolher 'Dados do negócio' não recolhe a linha do tempo", async () => {
    const user = userEvent.setup();
    montarDossie();

    await user.click(within(secao("dados-do-negocio")).getByRole("button", { name: "Dados do negócio" }));

    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("sim");
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("nao");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toEqual([
      "dados-do-negocio",
    ]);
  });

  it("reabrir a seção também é lembrado, e a outra continua fechada", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      CHAVE_DAS_SECOES_RECOLHIDAS,
      JSON.stringify(["dados-do-negocio", "linha-do-tempo"]),
    );
    montarDossie();

    await waitFor(() => expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("sim"));
    await user.click(within(secao("dados-do-negocio")).getByRole("button", { name: "Dados do negócio" }));

    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("nao");
    expect(JSON.parse(window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]")).toEqual([
      "linha-do-tempo",
    ]);
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
  });

  it("valor corrompido no storage abre tudo, sem derrubar o dossiê", () => {
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, "{não é json");
    montarDossie();

    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("nao");
    expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("nao");
  });

  it("storage bloqueado (aba privada) não derruba o dossiê nem o clique", async () => {
    const user = userEvent.setup();
    const estoura = () => {
      throw new Error("SecurityError");
    };
    // Na INSTÂNCIA, e não `spyOn`: o `Storage` do jsdom traz os métodos no
    // protótipo, e é a instância que o código usa.
    for (const metodo of ["getItem", "setItem"] as const) {
      Object.defineProperty(window.localStorage, metodo, { value: estoura, configurable: true });
    }

    try {
      montarDossie();
      await user.click(within(secao("linha-do-tempo")).getByRole("button", { name: "Linha do tempo" }));

      // O clique vale nesta sessão; só não sobrevive a um F5.
      expect(secao("linha-do-tempo").getAttribute("data-recolhida")).toBe("sim");
    } finally {
      for (const metodo of ["getItem", "setItem"] as const) {
        delete (window.localStorage as unknown as Record<string, unknown>)[metodo];
      }
    }
  });
});

describe("os campos do negócio continuam alcançáveis (#3181)", () => {
  it("recolhida, o formulário fica MONTADO e escondido; 'Editar campos' abre a seção", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify(["dados-do-negocio"]));
    montarDossie();

    await waitFor(() => expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("sim"));
    // Fechar no meio de uma edição não pode descartar o que já foi digitado.
    expect(peca("campos").closest("[hidden]")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Editar campos" }));

    expect(secao("dados-do-negocio").getAttribute("data-recolhida")).toBe("nao");
    expect(peca("campos").closest("[hidden]")).toBeNull();
    expect(within(secao("dados-do-negocio")).getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});
