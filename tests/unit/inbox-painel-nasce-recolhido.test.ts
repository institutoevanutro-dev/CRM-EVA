import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PAINEL DO CONTATO NASCE RECOLHIDO (pedido do André, 18/11/2026).
 *
 * Quem decide é o SERVIDOR, lendo o cookie em `app/app/inbox/page.tsx`: é o que
 * evita o painel pular de um estado para o outro na hidratação. Sem cookie
 * (primeiro acesso), recolhido; só "0", gravado por quem abriu pelo botão
 * (`togglePainelDoContato`), traz o painel aberto.
 */

const cookie = vi.hoisted(() => ({ valor: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nome: string) =>
      nome === "inbox_painel_recolhido" && cookie.valor !== undefined ? { value: cookie.valor } : undefined,
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "u1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "o1" }),
}));
vi.mock("@/components/inbox/InboxLayout", () => ({ InboxLayout: () => null }));

import InboxPage from "@/app/app/inbox/page";

async function painelRecolhidoInicial(): Promise<unknown> {
  const tela = (await InboxPage({ searchParams: Promise.resolve({}) })) as {
    props: { painelRecolhidoInicial?: unknown };
  };
  return tela.props.painelRecolhidoInicial;
}

describe("Inbox: o painel do contato nasce recolhido", () => {
  beforeEach(() => {
    cookie.valor = undefined;
  });

  it("⭐ sem cookie (primeiro acesso), recolhido", async () => {
    expect(await painelRecolhidoInicial()).toBe(true);
  });

  it('quem abriu pelo botão (cookie "0") volta a ver aberto', async () => {
    cookie.valor = "0";
    expect(await painelRecolhidoInicial()).toBe(false);
  });

  it('quem recolheu (cookie "1") segue recolhido', async () => {
    cookie.valor = "1";
    expect(await painelRecolhidoInicial()).toBe(true);
  });
});
