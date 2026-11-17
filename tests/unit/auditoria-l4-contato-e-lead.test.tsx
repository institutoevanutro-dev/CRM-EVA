/**
 * AUDITORIA L4 — "Contato e lead: dados que não se perdem" (achados 33 a 38).
 * O achado 6 (dossiê) tem arquivo próprio: dossie-nao-desfaz-gravacao-concorrente.
 * Cada caso aqui falha sem a correção correspondente. Nomes fictícios.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Contact, TimelineItemView } from "@/lib/types/contacts";
import { contactPatchSchema } from "@/lib/schemas/contacts";
import { opcoesDoFiltroDeEtiquetas } from "@/lib/contacts/etiquetas";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { LeadTimeline } from "@/components/kanban/LeadTimeline";

const CONTATO = {
  id: "ct-l4",
  organization_id: "org-1",
  name: "Marina Couto",
  display_name: null,
  email: "marina@exemplo.test",
  email_normalized: "marina@exemplo.test",
  phone_number: null,
  cpf_available: false,
  birthdate: "1990-05-04",
  is_blocked: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-09-14T10:00:00.000Z",
  updated_at: "2026-09-14T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

function envolver(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

let buscar: ReturnType<typeof vi.fn>;
beforeEach(() => {
  buscar = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { contact: CONTATO } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", buscar);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function corpoDoPatch(): Record<string, unknown> {
  const chamada = buscar.mock.calls.find(([url]) => String(url).includes("/api/v1/contacts/"));
  expect(chamada, "o diálogo não mandou PATCH").toBeTruthy();
  return JSON.parse(String((chamada?.[1] as RequestInit).body)) as Record<string, unknown>;
}

describe("achado 33 — apagar e-mail/nascimento do contato", () => {
  it("o campo limpo vai como null (e o vazio que já era vazio não vai)", async () => {
    envolver(<EditContactDialog contact={CONTATO} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Data de nascimento"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(buscar).toHaveBeenCalled());
    const corpo = corpoDoPatch();
    expect(corpo.email).toBeNull();
    expect(corpo.birthdate).toBeNull();
    expect(corpo).not.toHaveProperty("phone_number");
    expect(corpo.name).toBe("Marina Couto");
  });

  it("o schema do PATCH aceita null nos quatro campos", () => {
    const r = contactPatchSchema.safeParse({ name: null, email: null, phone_number: null, birthdate: null });
    expect(r.success).toBe(true);
  });
});

describe("achado 36 — Esc no campo de etiqueta", () => {
  it("com texto digitado, limpa só o texto; o diálogo fica aberto", () => {
    const onOpenChange = vi.fn();
    envolver(<EditContactDialog contact={CONTATO} open onOpenChange={onOpenChange} />);
    const campo = screen.getByLabelText("Adicionar etiqueta");
    fireEvent.change(campo, { target: { value: "retorno" } });
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(campo).toHaveValue("");
    // Sem texto, o Esc volta a fechar o diálogo.
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("achado 34 — filtro de etiquetas da lista de contatos", () => {
  it("oferece o vocabulário da organização, não só o da página filtrada", () => {
    const opcoes = opcoesDoFiltroDeEtiquetas({
      vocabulario: ["vip", "retorno", "orçamento"],
      carregadas: ["vip"],
      selecionadas: ["vip"],
    });
    expect(opcoes).toEqual(["orçamento", "retorno", "vip"]);
  });
});

function item(id: string, segundos: number, extra: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id,
    type: "note_added",
    performed_at: new Date(Date.UTC(2026, 10, 10, 12, 0, segundos)).toISOString(),
    actor_kind: "agent",
    actor_agent_id: "ag-1",
    actor_agent_name: "Assistente",
    performed_by_user_id: null,
    actor_user_name: null,
    payload: {},
    ...extra,
  } as unknown as TimelineItemView;
}

describe("achado 37 — grupo aberto da linha do tempo", () => {
  it("uma entrada nova ao vivo não troca qual grupo está aberto", () => {
    const grupo = [item("g3", 30), item("g2", 20), item("g1", 10)];
    const { rerender } = render(
      <LeadTimeline itens={grupo} chegouAoVivo={new Set()} isLoading={false} isError={false} />,
    );
    const botao = screen.getByRole("button", { expanded: false });
    fireEvent.click(botao);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();

    const novo = item("novo", 50, { actor_kind: "user", actor_agent_id: null, performed_by_user_id: "u-1", actor_user_name: "Rita Alves" } as Partial<TimelineItemView>);
    rerender(
      <LeadTimeline itens={[novo, ...grupo]} chegouAoVivo={new Set(["novo"])} isLoading={false} isError={false} />,
    );
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
  });
});
