/**
 * "SALVAR E INICIAR CONVERSA" NO CADASTRO DE CONTATO (#3483).
 *
 * ─── O que a issue pedia ────────────────────────────────────────────────────
 *
 * Ao cadastrar um contato, quem atende ficava na tela de Contatos sem caminho
 * direto para começar a conversa: precisava sair, ir ao Inbox, clicar em
 * "Iniciar conversa" e procurar o contato de novo. O botão novo encurta isso —
 * e o pedido é que ele faça o MESMO que o Inbox faz, não um caminho paralelo.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 *  1. o botão novo cria o contato, abre a conversa por
 *     `POST /conversations/open-with-contact` com o `contact_id` que a rota
 *     devolveu, pede o `claim` (`expected_assignee: null`) e leva ao Inbox;
 *  2. o botão antigo ("Criar contato") continua NÃO abrindo conversa nenhuma —
 *     a conversa não pode nascer de um clique que não a pediu;
 *  3. a recusa do servidor (403 = papel insuficiente) aparece e NÃO navega: o
 *     atalho não abre porta que o Inbox fechava;
 *  4. contato salvo sem telefone não abre thread 1:1, e o motivo é dito — o
 *     cadastro não se perde por causa disso.
 *
 * Portado do projeto original (DeskcommCRM, PR #3547), sem os casos da lista
 * de Contatos e da agenda, que dependem de telas que divergiram neste fork.
 *
 * Dublê de `fetch`, componente de verdade: é a única forma de medir a ORDEM dos
 * pedidos (criar → abrir → assumir → navegar), que é onde o defeito moraria.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateContactResult } from "@/app/api/v1/contacts/_handler";
import type { ApiSuccess } from "@/lib/api/wrappers";
import type { Contact } from "@/lib/types/contacts";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";

const pushMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
const showApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null }),
  useAuth: () => ({ user: { id: "usuario-eu" } }),
  usePermission: () => true,
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: showApiErrorMock }));

const CONTATO = {
  id: "ct-77",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: "+5511987654321",
  birthdate: null,
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
  cpf_available: false,
} satisfies Contact;

const CORPO_DA_ROTA: ApiSuccess<CreateContactResult> = {
  data: { contact: CONTATO, action: "created" },
};

function envolver(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * O roteador do dublê. `abrir` e `claim` são ganchos por caso, porque é o
 * desfecho DELES que muda entre os testes; o resto é sempre o mesmo corpo.
 */
function rotear(
  opts: {
    abertura?: () => Response;
    claim?: () => Response;
    contato?: Contact;
    canais?: number;
    erroContato?: boolean;
  } = {},
) {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const caminho = String(url);
    if (caminho.includes("/api/v1/contact-tags")) return resposta({ data: [] });
    if (caminho.includes("/api/v1/agenda/vinculos"))
      return resposta({ data: { contacts: [], conversations: [] } });
    if (caminho.includes("/api/v1/channel-sessions"))
      return resposta({
        data: Array.from({ length: opts.canais ?? 0 }, (_, i) => ({
          id: `canal-${i + 1}`,
          display_name: `Canal ${i + 1}`,
          provider: DEFAULT_CHANNEL_PROVIDER,
          status: "WORKING",
          phone_number: `+551198765430${i}`,
          metadata: {},
        })),
      });
    if (caminho.includes("/api/v1/contacts")) {
      if (init?.method !== "POST") return resposta({ data: [], meta: { has_more: false } });
      if (opts.erroContato) {
        return resposta({ error: { code: "validation_error", message: "Contato recusado." } }, 422);
      }
      return resposta(
        opts.contato
          ? ({ data: { contact: opts.contato, action: "created" } } as unknown)
          : CORPO_DA_ROTA,
        201,
      );
    }
    if (caminho.includes("/open-with-contact")) {
      return opts.abertura ? opts.abertura() : resposta({ data: { conversation_id: "conv-1" } });
    }
    if (caminho.endsWith("/claim")) return opts.claim ? opts.claim() : resposta({ data: {} });
    return resposta({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Só os pedidos que interessam, na ORDEM em que saíram. */
function caminhos(fetchMock: ReturnType<typeof rotear>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([url]) => String(url))
    .filter(
      (c) =>
        c.includes("/api/v1/contacts") || c.includes("/open-with-contact") || c.endsWith("/claim"),
    )
    .map((c) => c.replace("http://localhost", ""));
}

/** O corpo JSON do pedido que termina em `sufixo`. */
function corpoDo(fetchMock: ReturnType<typeof rotear>, sufixo: string): Record<string, unknown> {
  const chamada = fetchMock.mock.calls.find(([url]) => String(url).endsWith(sufixo)) as
    [unknown, RequestInit?] | undefined;
  return JSON.parse(String(chamada?.[1]?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  pushMock.mockReset();
  showApiErrorMock.mockReset();
  Object.values(toastMock).forEach((f) => f.mockReset());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("NewContactDialog · salvar e iniciar conversa (#3483)", () => {
  it("⭐ cria o contato, abre a conversa dele, assume e vai para o Inbox", async () => {
    const fetchMock = rotear();
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511987654321");
    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/app/inbox?id=conv-1"));

    // A ORDEM é o contrato: criar → abrir → assumir. Abrir antes de o contato
    // existir mandaria um `contact_id` que ninguém conhece; assumir antes de
    // abrir não teria conversa para assumir.
    expect(caminhos(fetchMock)).toEqual([
      "/api/v1/contacts",
      "/api/v1/conversations/open-with-contact",
      "/api/v1/conversations/conv-1/claim",
    ]);

    // O `contact_id` é o que a ROTA devolveu — não um id inventado pela tela.
    expect(corpoDo(fetchMock, "/open-with-contact")).toMatchObject({ contact_id: "ct-77" });
    // O claim do Inbox: "assuma se estiver livre".
    expect(corpoDo(fetchMock, "/claim")).toEqual({ expected_assignee: null });
    expect(toastMock.success).toHaveBeenCalledWith("Contato criado");
  });

  it("o botão de sempre ('Criar contato') continua sem abrir conversa nenhuma", async () => {
    const fetchMock = rotear();
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511987654321");
    await user.click(screen.getByRole("button", { name: "Criar contato" }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Contato criado"));
    // A conversa não nasce de um clique que não a pediu: quem só quer cadastrar
    // não pode ganhar um atendimento aberto no Inbox.
    expect(caminhos(fetchMock)).toEqual(["/api/v1/contacts"]);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("recusa do servidor (sem papel) aparece e NÃO navega", async () => {
    // 403 é o que `open-with-contact` devolve a quem não é `agent` (spec 13
    // §4). O caminho novo herda a recusa do antigo — nada aqui a contorna.
    const fetchMock = rotear({
      abertura: () => resposta({ error: { code: "forbidden", message: "Sem permissão." } }, 403),
    });
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText(/Telefone/i), "+5511987654321");
    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalled());
    // Sem conversa aberta não há o que assumir, e sem conversa não há para onde
    // navegar — e o cadastro JÁ foi feito: ele não é desfeito pela recusa.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/claim"))).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
    expect(toastMock.success).toHaveBeenCalledWith("Contato criado");
  });

  it("contato salvo sem telefone: não abre conversa e diz o motivo", async () => {
    const semTelefone = { ...CONTATO, phone_number: null } satisfies Contact;
    const fetchMock = rotear({ contato: semTelefone });
    const user = userEvent.setup();
    envolver(<NewContactDialog open onOpenChange={vi.fn()} nomeInicial="Joana Prado" />);

    await user.type(screen.getByLabelText(/Email/i), "joana@exemplo.com");
    await user.click(screen.getByRole("button", { name: "Salvar e iniciar conversa" }));

    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "Contato salvo. Cadastre um telefone para abrir a conversa.",
      ),
    );
    // A régua é o telefone GRAVADO, não o digitado: quem decide é o servidor.
    expect(caminhos(fetchMock)).toEqual(["/api/v1/contacts"]);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
