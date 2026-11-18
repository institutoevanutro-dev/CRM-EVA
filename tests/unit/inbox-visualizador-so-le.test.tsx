/**
 * Item 37 da auditoria de 17/11: quem não tem a permissão não vê o botão.
 *
 * O "Visualizador" via o campo de digitar e Assumir, Transferir, Fechar… — e
 * tudo voltava "sem permissão". Na aba Comentários, "Nova regra", "Palavras da
 * IA" e "Frases do Direct" apareciam para atendente e só gravavam com gestor.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let papel: "viewer" | "agent" | "manager" = "viewer";
const RANK = { viewer: 1, agent: 2, manager: 3, admin: 4 } as const;
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "u-1" }, activeOrg: { orgId: "org-1", role: papel } }),
  // `inbox.reply` pede `agent`, como no mapa de permissões de verdade.
  usePermission: (acao: string) => (acao === "inbox.reply" ? RANK[papel] >= RANK.agent : true),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(), patch: vi.fn() } }));
vi.mock("@/hooks/comentarios/useComentarios", () => ({
  useComentarios: () => ({ data: [], isLoading: false }),
  usePublicarComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useCriarRegraDeComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useDescartarComentario: () => ({ mutate: vi.fn(), isPending: false }),
  useCanaisDoInstagram: () => ({ data: [] }),
  usePublicacoesDosPerfis: () => new Map(),
}));

import { ConversationHeader } from "@/components/inbox/ConversationHeader";
import { ComentariosPainel } from "@/components/inbox/comentarios/ComentariosPainel";

function comQuery(no: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{no}</QueryClientProvider>);
}

const conversa = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: "ct-1",
  status: "open",
  assigned_to_user_id: null,
  assignee_kind: null,
  snooze_until: null,
  service_revision: 1,
  tags: [],
  contacts: { id: "ct-1", display_name: "Paciente Fictícia", name: null, phone_number: "+5527999990000" },
} as unknown as React.ComponentProps<typeof ConversationHeader>["conversation"];

describe("item 37 — o visualizador só lê", () => {
  beforeEach(() => {
    papel = "viewer";
  });

  it("⭐ cabeçalho: sem Assumir, Transferir, Lembrar, Fechar nem ações do menu", () => {
    comQuery(<ConversationHeader conversation={conversa} onBuscar={() => {}} />);
    for (const nome of ["Assumir", "Transferir", "Fechar", "Lembrar"]) {
      expect(screen.queryByRole("button", { name: nome }), nome).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Ações da conversa" }));
    const menu = screen.getByTestId("menu-da-conversa");
    expect(menu).toHaveTextContent("Buscar nesta conversa");
    expect(menu).not.toHaveTextContent("Arquivar");
    expect(menu).not.toHaveTextContent("Ocultar");
  });

  it("o atendente continua vendo as ações", () => {
    papel = "agent";
    comQuery(<ConversationHeader conversation={conversa} onBuscar={() => {}} />);
    expect(screen.getByRole("button", { name: "Assumir" })).toBeInTheDocument();
  });

  it("comentários: atendente não vê os editores de gestor; gestor vê", () => {
    papel = "agent";
    const r = comQuery(<ComentariosPainel />);
    for (const nome of ["Nova regra", "Palavras da IA", "Frases do Direct"]) {
      expect(screen.queryByRole("button", { name: nome }), nome).toBeNull();
    }
    r.unmount();
    papel = "manager";
    comQuery(<ComentariosPainel />);
    for (const nome of ["Nova regra", "Palavras da IA", "Frases do Direct"]) {
      expect(screen.getByRole("button", { name: nome }), nome).toBeInTheDocument();
    }
  });
});
