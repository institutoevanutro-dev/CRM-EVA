/**
 * ⌘K. Até aqui a barra "Buscar…" do topo era um `console.info` com o comentário
 * "UI not yet implemented" — a única saída de emergência para quem não achava
 * uma tela era uma promessa vazia.
 *
 * Acha telas e, desde o item 233, contatos e conversas pelas rotas das próprias
 * telas (aqui, `apiClient` simulado; dados fictícios).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CommandPalette } from "@/components/shell/CommandPalette";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const push = vi.fn();
const authRef: { user: Pick<AuthUser, "is_platform_admin">; activeOrg: ActiveOrg | null } = {
  user: { is_platform_admin: false },
  activeOrg: { orgId: "org-1", name: "Org", role: "admin" },
};

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => authRef }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const get = vi.fn().mockResolvedValue({ data: [] });
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

function comoPapel(role: ActiveOrg["role"]) {
  authRef.activeOrg = { orgId: "org-1", name: "Org", role };
}

afterEach(() => {
  cleanup();
  push.mockClear();
  get.mockReset().mockResolvedValue({ data: [] });
  comoPapel("admin");
});

function abrir(aoNavegar?: () => void) {
  return render(<CommandPalette open onOpenChange={() => {}} aoNavegar={aoNavegar} />);
}

describe("CommandPalette", () => {
  it("acha uma tela que o sidebar não mostra", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    expect(screen.getByRole("option", { name: /Conhecimento/ })).toBeTruthy();
  });

  it("ignora acento, porque ninguém digita acento com pressa", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "orcamento");
    expect(screen.getByRole("option", { name: /Uso e orçamento/ })).toBeTruthy();
  });

  it("busca também na descrição, não só no rótulo", async () => {
    const user = userEvent.setup();
    abrir();
    // Ninguém procura "Radar" por esse nome; procura pelo problema que resolve.
    await user.type(screen.getByRole("combobox"), "esfriou");
    expect(screen.getByRole("option", { name: /Radar/ })).toBeTruthy();
  });

  it("respeita o papel", async () => {
    comoPapel("agent");
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "histórico de alterações");
    expect(screen.queryByRole("option", { name: /Histórico de alterações/ })).toBeNull();
  });

  it("Enter navega para o item destacado", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/app/ai/knowledge/sources");
  });

  it("seta para baixo move o destaque antes do Enter", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "a");
    await user.keyboard("{ArrowDown}{Enter}");
    const segundo = screen.getAllByRole("option")[1];
    expect(segundo).toBeDefined();
    expect(push).toHaveBeenCalledWith(segundo?.getAttribute("data-href"));
  });

  it("sem texto, oferece o trabalho do dia em vez de tela vazia", () => {
    abrir();
    expect(screen.getByRole("option", { name: /Conversas/ })).toBeTruthy();
  });

  it("acha contato e conversa pelo nome, e abre a ficha ou a conversa (item 233)", async () => {
    get.mockImplementation(async (url: string) =>
      url.startsWith("/api/v1/contacts")
        ? { data: [{ id: "c1", display_name: "Maria Exemplo", name: null, phone_number: "5527999990000" }] }
        : { data: [{ id: "v1", last_message_preview: "Oi, tudo bem?", contacts: { id: "c1", display_name: "Maria Exemplo", name: null, phone_number: null } }] },
    );
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "maria");
    const contato = await screen.findByRole("option", { name: /Maria Exemplo.*Contato/ });
    expect(contato.getAttribute("data-href")).toBe("/app/contacts/c1");
    const conversa = screen.getByRole("option", { name: /Maria Exemplo.*Conversa/ });
    expect(conversa.getAttribute("data-href")).toBe("/app/inbox?id=v1");
    expect(get.mock.calls.map((c) => c[0])).toEqual([
      "/api/v1/contacts?search=maria&limit=5",
      "/api/v1/conversations?search=maria&limit=5",
    ]);
  });

  it("se a rota recusa (papel sem acesso), as telas continuam e nada quebra", async () => {
    get.mockRejectedValue(new Error("403"));
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "conhec");
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("option", { name: /Conhecimento/ })).toBeTruthy();
  });

  it("\"avisos\" acha a Central de avisos (item 234)", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "avisos");
    expect(screen.getByRole("option", { name: /Central de avisos/ })).toBeTruthy();
  });

  it("a seta rola a lista até o destacado, e escolher fecha a gaveta (item 234)", async () => {
    const rolar = vi.fn();
    Element.prototype.scrollIntoView = rolar;
    const aoNavegar = vi.fn();
    const user = userEvent.setup();
    abrir(aoNavegar);
    await user.keyboard("{ArrowDown}");
    expect(rolar).toHaveBeenCalledWith({ block: "nearest" });
    await user.keyboard("{Enter}");
    expect(aoNavegar).toHaveBeenCalledOnce();
  });

  it("diz quando não achou, em vez de sumir sem explicação", async () => {
    const user = userEvent.setup();
    abrir();
    await user.type(screen.getByRole("combobox"), "zzzzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Nada encontrado/i)).toBeTruthy();
  });
});
