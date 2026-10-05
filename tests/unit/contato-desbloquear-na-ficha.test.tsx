/**
 * O BOTÃO DE DESBLOQUEAR, NA FICHA DO CONTATO.
 *
 * Quem escreveu PARAR (ou caiu num bloqueio por engano) ficava bloqueado para
 * sempre: não havia botão nem rota que desfizesse. A rota tem o teste dela
 * (`app/api/v1/contacts/[id]/unblock/route.test.ts`); este arquivo mede a TELA,
 * que é onde o dono da clínica exerce o desbloqueio:
 *
 *   - o botão só existe para ADMINISTRADOR e só em contato BLOQUEADO;
 *   - um clique NÃO desbloqueia — abre a confirmação, que diz o que volta a
 *     acontecer e que o negócio fechado como perdido continua fechado;
 *   - só o "Desbloquear" de dentro da confirmação chama a ação.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";

const desbloquear = vi.fn();
let papel: "admin" | "manager" | "agent" = "admin";
let suporte: { access_mode: string } | null = null;
let bloqueado = true;

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: suporte },
    activeOrg: { orgId: "org-1", name: "Clínica", role: papel, cliente_pela_agenda: false },
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    data: {
      data: {
        id: "c-1",
        organization_id: "org-1",
        name: "Joana Prado",
        display_name: "Joana",
        email: null,
        phone_number: null,
        cpf_available: false,
        birthdate: null,
        is_blocked: bloqueado,
        blocked_reason: bloqueado ? "stop_keyword" : null,
        is_anonymized: false,
        anonymized_at: null,
        consent: {},
        tags: [],
        source: "whatsapp",
        source_metadata: {},
        custom_fields: {},
        created_at: "2026-01-01T10:00:00.000Z",
        updated_at: "2026-01-01T10:00:00.000Z",
        last_activity_at: null,
        first_service_at: null,
      },
    },
  }),
}));
vi.mock("@/hooks/contacts/useUnblockContact", () => ({
  useUnblockContact: () => ({ mutate: desbloquear, isPending: false }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));

function abrirFicha() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ContactDetailClient contactId="c-1" />
    </QueryClientProvider>,
  );
}

const botao = () => screen.queryByRole("button", { name: "Desbloquear" });

beforeEach(() => {
  desbloquear.mockClear();
  papel = "admin";
  suporte = null;
  bloqueado = true;
});

describe("desbloquear contato, na ficha", () => {
  it("administrador vê o botão no contato bloqueado", () => {
    abrirFicha();
    // Controle de vacuidade: a ficha renderizou e o contato está bloqueado.
    expect(screen.getByText("Bloqueado")).toBeInTheDocument();
    expect(botao()).not.toBeNull();
  });

  it.each(["manager", "agent"] as const)("%s NÃO vê o botão", (quem) => {
    papel = quem;
    abrirFicha();
    expect(screen.getByText("Bloqueado")).toBeInTheDocument();
    expect(botao()).toBeNull();
  });

  it("contato que não está bloqueado não tem o que desbloquear", () => {
    bloqueado = false;
    abrirFicha();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
    expect(botao()).toBeNull();
  });

  it("acompanhamento somente leitura não vê o botão", () => {
    suporte = { access_mode: "support_readonly" };
    abrirFicha();
    expect(screen.getByText("Bloqueado")).toBeInTheDocument();
    expect(botao()).toBeNull();
  });

  it("um clique só abre a confirmação — e ela diz que o negócio continua fechado", () => {
    abrirFicha();
    fireEvent.click(botao()!);

    expect(desbloquear).not.toHaveBeenCalled();
    const confirmacao = screen.getByRole("alertdialog");
    expect(confirmacao).toHaveTextContent("Desbloquear este contato?");
    expect(confirmacao).toHaveTextContent("O negócio fechado como perdido continua fechado.");
  });

  it("cancelar não desbloqueia; confirmar desbloqueia uma vez", () => {
    abrirFicha();
    fireEvent.click(botao()!);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(desbloquear).not.toHaveBeenCalled();

    fireEvent.click(botao()!);
    const confirmacao = screen.getByRole("alertdialog");
    const confirmar = Array.from(confirmacao.querySelectorAll("button")).find(
      (b) => b.textContent === "Desbloquear",
    );
    fireEvent.click(confirmar!);
    expect(desbloquear).toHaveBeenCalledTimes(1);
  });
});
