import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConexaoCaidaBanner } from "@/components/app/ConexaoCaidaBanner";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { AuthUser, Role } from "@/lib/auth/types";
import type { ConexaoCaida } from "@/lib/channels/health";

vi.mock("@/lib/supabase/browser", () => ({
  resetRealtimeAuthentication: vi.fn(),
  createClient: () => ({ auth: { refreshSession: vi.fn() } }),
}));

const baseUser: AuthUser = {
  id: "actor", email: "actor@example.test", full_name: null, avatar_url: null,
  organizations: [{ organization_id: "org", organization_name: "Organização", role: "admin" }],
  idioma: "pt-BR", is_platform_admin: false,
};
const support: NonNullable<AuthUser["support"]> = {
  id: "support", organization_id: "org", actor_user_id: "actor", auth_session_id: "session",
  previous_organization_id: null, expires_at: "2030-01-01T00:00:00Z", name: "Organização",
  locale: "pt-BR", access_mode: "support_readonly", status: "active",
};
function view(role: Role, locale: "pt-BR" | "es", who = baseUser, caidas: ConexaoCaida[] = [{ id: "channel", apelido: "Vendas", status: "SCAN_QR_CODE" }]) {
  return <AuthProvider user={who} activeOrg={{ orgId: "org", name: "Organização", role }}>
    <IdiomaProvider locale={locale}><ConexaoCaidaBanner caidas={caidas} /></IdiomaProvider>
  </AuthProvider>;
}
const copy = {
  "pt-BR": { qr: "Escanear o QR", connections: "Ver conexões", help: "Peça a quem administra para revisar a conexão do WhatsApp.", outage: "nenhuma mensagem entra nem sai.", details: "Detalhes" },
  es: { qr: "Escanear el QR", connections: "Ver conexiones", help: "Pide a quien administra que revise la conexión de WhatsApp.", outage: "ningún mensaje entra ni sale.", details: "Detalles" },
};

// A faixa também consulta a lista de conexões (item 57). Aqui a consulta não
// responde: o que governa é a primeira pintura, `caidas`, vinda do servidor.
beforeEach(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["pt-BR", "es"] as const)("alerta de conexão em %s", locale => {
  it.each([
    ["admin do tenant", "admin", baseUser],
    ["plataforma fora do suporte", "agent", { ...baseUser, is_platform_admin: true }],
    ["suporte de edição", "admin", { ...baseUser, is_platform_admin: true, support: { ...support, access_mode: "full" } }],
  ] as const)("%s abre Conexões com a ação adequada ao estado", (_name, role, who) => {
    const mounted = render(view(role, locale, who));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Vendas");
    expect(within(alert).getByRole("link", { name: copy[locale].qr })).toHaveAttribute("href", "/app/connections");
    expect(within(alert).queryByText(copy[locale].help)).toBeNull();
    mounted.rerender(view(role, locale, who, [{ id: "channel", apelido: "Vendas", status: "FAILED" }]));
    expect(within(screen.getByRole("alert")).getByRole("link", { name: copy[locale].connections })).toHaveAttribute("href", "/app/connections");
  });

  it.each([
    ["atendente", "agent", baseUser],
    ["gerente", "manager", baseUser],
    ["viewer", "viewer", baseUser],
    ["plataforma em suporte somente leitura com vínculo físico admin", "viewer", { ...baseUser, is_platform_admin: true, support }],
  ] as const)("%s recebe o alerta e uma orientação, sem CTA proibida", (_name, role, who) => {
    render(view(role, locale, who));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Vendas");
    expect(alert).toHaveTextContent(copy[locale].outage);
    expect(within(alert).queryByRole("link")).toBeNull();
    // A orientação mora em "Detalhes" desde que a faixa virou uma linha (item 59):
    // a um toque, e não mais quebrando a faixa em quatro linhas no celular.
    fireEvent.click(within(alert).getByText(copy[locale].details));
    expect(within(alert).getByText(copy[locale].help)).toBeVisible();
  });

  it("retira o alerta quando não há conexão caída", () => {
    const mounted = render(view("agent", locale));
    expect(screen.getByRole("alert")).toBeVisible();
    mounted.rerender(view("agent", locale, baseUser, []));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/**
 * Auditoria de 17/11, itens 57 e 58. A faixa só era calculada ao carregar a
 * página: o número caía e ninguém via; voltava, e ela ficava até o F5. E uma
 * conexão que alguém começou e nunca pareou fazia todos lerem "WhatsApp sem nome
 * está desconectado".
 */
describe("a faixa segue a lista de conexões, sem recarregar", () => {
  const lista = (sessoes: Array<Record<string, unknown>>) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: sessoes }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  const sessao = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "s1", display_name: "Recepção", phone_number: "5527999990000", status, nunca_pareou: false, ...extra,
  });

  it("o número cai depois de a página abrir: a faixa aparece", async () => {
    lista([sessao("FAILED")]);
    render(view("agent", "pt-BR", baseUser, []));
    expect(await screen.findByRole("alert")).toHaveTextContent("Recepção");
  });

  it("o número volta: a faixa some", async () => {
    lista([sessao("WORKING")]);
    render(view("agent", "pt-BR", baseUser, [{ id: "s1", apelido: "Recepção", status: "SCAN_QR_CODE" }]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("conexão que nunca pareou não vira faixa", async () => {
    lista([sessao("SCAN_QR_CODE", { id: "s2", display_name: null, phone_number: null, nunca_pareou: true }), sessao("WORKING")]);
    render(view("agent", "pt-BR", baseUser, [{ id: "s2", apelido: "sem nome", status: "SCAN_QR_CODE" }]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
