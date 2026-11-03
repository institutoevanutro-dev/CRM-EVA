/**
 * O NÚMERO DAS ABAS E O SELETOR DE NÚMERO NÃO DIVERGEM NA HIDRATAÇÃO (#3736).
 *
 * Portado do projeto original (DeskcommCRM, PR #3832 de @webtecnica), adaptado.
 *
 * Medido no original, em build de produção (543 cargas, 3 erros): `Minified
 * React error #418`, `isText=false` — divergência de NÓ, não de texto — no
 * `<span>` da contagem dentro do `TabsTrigger`. O SSR sai SEM a contagem (ela
 * vem de react-query e só existe no navegador); quando a resposta chegava
 * DURANTE a hidratação, o primeiro render do cliente já trazia o `<span>` e o
 * React comparava com um HTML que não tinha o nó.
 *
 * No fork a contagem é a pílula `Contagem` de `InboxFilters`, e o seletor de
 * número da empresa tem o mesmo desenho: ele só existe com 2+ canais, e a lista
 * de canais também chega por react-query (para quem administra, o indicador de
 * conexões do menu pede a MESMA chave antes de o Inbox hidratar).
 *
 * O componente e o hook são os de produção; só as consultas são dublês. O HTML
 * do servidor vem de `renderToString` de verdade e a hidratação é `hydrateRoot`
 * de verdade — o erro que este teste persegue só aparece nesse caminho.
 */
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** O que "chega" do servidor de dados. `null`/vazio = ainda não chegou. */
const dados = vi.hoisted(() => ({
  contagens: null as { fila: number } | null,
  canais: [] as { id: string; display_name: string }[],
}));

vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: dados.contagens }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", role: "manager", visibility_mode: "all" },
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: dados.canais }),
  channelLabel: (c: { display_name: string }) => c.display_name,
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/components/inbox/SeletorDeAtendente", () => ({
  SeletorDeAtendente: () => null,
}));

import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";

const FILTRO: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };

/** HTML do servidor, `antesDeHidratar` (a resposta que chega no meio), hidratação. */
async function hidratar(antesDeHidratar: () => void) {
  const html = renderToString(<InboxFilters value={FILTRO} onChange={() => {}} />);
  antesDeHidratar();

  const erros: unknown[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  await act(async () => {
    hydrateRoot(container, <InboxFilters value={FILTRO} onChange={() => {}} />, {
      onRecoverableError: (erro) => erros.push(erro),
    });
  });

  const avisosDeHidratacao = consoleError.mock.calls.filter((c) => /hydrat/i.test(String(c[0])));
  return { container, erros, avisosDeHidratacao };
}

beforeEach(() => {
  dados.contagens = null;
  dados.canais = [];
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Inbox › as abas hidratam sem divergir do HTML do servidor (#3736)", () => {
  it("controle: o HTML do servidor sai SEM a contagem, mesmo com ela em mãos", () => {
    dados.contagens = { fila: 41 };
    const html = renderToString(<InboxFilters value={FILTRO} onChange={() => {}} />);
    expect(html).toContain("Fila");
    expect(html, "o servidor passou a imprimir a contagem: a divergência volta").not.toContain(
      "tabular-nums",
    );
  });

  it("a contagem chega DURANTE a hidratação: nenhum erro recuperável, e ela aparece depois", async () => {
    const { container, erros, avisosDeHidratacao } = await hidratar(() => {
      dados.contagens = { fila: 41 };
    });

    expect(erros, "o React teve de recuperar a árvore: a contagem divergiu do HTML").toEqual([]);
    expect(avisosDeHidratacao).toEqual([]);
    // E a contagem NÃO foi escondida para sempre: depois de montar, ela está lá.
    expect(container.querySelectorAll(".tabular-nums").length).toBe(1);
    expect(container.textContent).toContain("41");
  });

  it("os canais chegam DURANTE a hidratação: nenhum erro recuperável, e o seletor de número aparece depois", async () => {
    const { container, erros, avisosDeHidratacao } = await hidratar(() => {
      dados.canais = [
        { id: "sessao-1", display_name: "Recepção" },
        { id: "sessao-2", display_name: "Instagram da clínica" },
      ];
    });

    expect(erros, "o React teve de recuperar a árvore: o seletor de número divergiu do HTML").toEqual([]);
    expect(avisosDeHidratacao).toEqual([]);
    expect(container.querySelector("[role='combobox']")).not.toBeNull();
  });
});
