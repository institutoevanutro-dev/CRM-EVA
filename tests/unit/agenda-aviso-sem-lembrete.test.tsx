/**
 * A10 (pacote 2 de design): avisar quando o paciente pediu para não receber
 * mensagens.
 *
 * A promessa da faixa ("O lembrete não será enviado") só é verdade porque o
 * cron `agenda-reminder` pula `contato_bloqueado`; o primeiro bloco abaixo
 * prende essa guarda, para a frase não passar a mentir em silêncio.
 * Nomes fictícios.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { MarcacaoSimples } from "@/components/agenda/MarcacaoSimples";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { listaAgendamentos } from "@/lib/agenda/consulta";

const ANA = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const PESSOAS = [{ id: ANA, nome: "Dra. Ana Teste", trilha: 1 }] as unknown as Pessoa[];
const INSTANTE = "2026-10-22T16:00:00.000Z";

let contatoNoBanco: Record<string, unknown> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  contatoNoBanco = null;
  api.get.mockImplementation(async (url: string) =>
    url.includes(`contact_id=${CONTATO}`) && contatoNoBanco
      ? { data: { contacts: [contatoNoBanco], conversations: [] } }
      : { data: { contacts: [], conversations: [] } },
  );
});
afterEach(cleanup);

describe("a frase só promete o que o lembrete cumpre", () => {
  it("o cron de lembretes da agenda pula quem pediu para não receber mensagens", () => {
    const cron = readFileSync(join(process.cwd(), "app/api/v1/cron/agenda-reminder/route.ts"), "utf8");
    expect(cron).toMatch(/if \(contato\.is_blocked\) \{\s*pular\("contato_bloqueado"\);/);
  });
});

function montar(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const base: ComponentProps<typeof MarcacaoSimples> = {
    ancora: new Date(2026, 9, 22, 12),
    agora: new Date(2026, 9, 22, 8),
    usuarioId: ANA,
    pessoas: PESSOAS,
    tipos: [{ id: "t-ana", nome: "Avaliação facial", duracaoMin: 45, donoId: ANA, localDetalhes: null, exigePaciente: false }],
    profissionalId: ANA,
    onProfissional: vi.fn(),
    tipoId: "t-ana",
    onTipo: vi.fn(),
    contactId: CONTATO,
    conversationId: "",
    onVinculo: vi.fn(),
    unidades: [],
    unidadeId: "",
    onUnidade: vi.fn(),
    fuso: "America/Sao_Paulo",
    horariosPorDia: { "2026-10-22": [{ instante: INSTANTE, rotulo: "13:00" }] },
    publicouHorarios: true,
    erroAoCarregar: false,
    fusoSuposto: false,
    onMesVisivel: vi.fn(),
    mesCarregado: new Date(2026, 9, 1),
    horarioInicial: { instante: INSTANTE, rotulo: "13:00" },
    permiteEncaixe: true,
    podeBloquearDeOutros: true,
    onConfirmar: vi.fn(async () => undefined),
    onVerNaAgenda: vi.fn(),
  };
  render(
    <QueryClientProvider client={qc}>
      <MarcacaoSimples {...base} {...props} />
    </QueryClientProvider>,
  );
}

describe("marcação simples: a faixa no rodapé", () => {
  it("paciente bloqueado: a faixa diz o nome e o que fazer, e o Confirmar continua ativo", async () => {
    contatoNoBanco = { id: CONTATO, name: "Carla Fictícia", display_name: null, phone_number: null, is_blocked: true };
    montar();
    const aviso = await screen.findByTestId("aviso-sem-lembrete");
    expect(screen.getByTestId("confirmacao")).toContainElement(aviso);
    expect(aviso.textContent).toBe(
      "Carla Fictícia pediu para não receber mensagens. O lembrete não será enviado — combine por telefone.",
    );
    expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled();
  });

  it("quem aceita mensagem, ou servidor que não manda o campo, não vê a faixa", async () => {
    contatoNoBanco = { id: CONTATO, name: "Carla Fictícia", display_name: null, phone_number: null, is_blocked: false };
    montar();
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    expect(screen.queryByTestId("aviso-sem-lembrete")).toBeNull();

    cleanup();
    contatoNoBanco = { id: CONTATO, name: "Carla Fictícia", display_name: null, phone_number: null };
    montar();
    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    expect(screen.queryByTestId("aviso-sem-lembrete")).toBeNull();
  });
});

describe("a grade: sino cortado no bloco", () => {
  const base: Agendamento = {
    id: "ag-1",
    titulo: "Avaliação facial",
    quemSeraAtendido: "Carla Fictícia",
    responsavelId: ANA,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T13:45:00-03:00",
    origem: "ui",
    situacao: "confirmed",
  };
  function grade(a: Agendamento) {
    render(
      <GradeDaAgenda
        visao="semana"
        ancora={new Date("2026-09-16T12:00:00-03:00")}
        agora={new Date("2026-09-16T08:00:00-03:00")}
        fuso="America/Sao_Paulo"
        agendamentos={[a]}
        pessoas={PESSOAS}
      />,
    );
  }

  it("quem não recebe mensagens ganha o sino, para quem vê e para quem ouve", () => {
    grade({ ...base, naoRecebeMensagens: true });
    expect(screen.getByTestId("sem-lembrete-ag-1")).toBeInTheDocument();
    expect(screen.getByTestId("agendamento-ag-1").getAttribute("aria-label")).toContain("sem lembrete");
    expect(screen.getByTestId("agendamento-ag-1").getAttribute("title")).toContain("Sem lembrete");
  });

  it("quem recebe não ganha sino", () => {
    grade(base);
    expect(screen.queryByTestId("sem-lembrete-ag-1")).toBeNull();
  });
});

describe("a listagem diz quem não recebe mensagens", () => {
  function agendaCom(contactId: string | null, contacts: unknown): SupabaseClient {
    const linha = {
      id: "ag-1",
      title: "Avaliação facial",
      starts_at: INSTANTE,
      ends_at: "2026-10-22T16:45:00.000Z",
      time_zone: "America/Sao_Paulo",
      status: "confirmed",
      revision: 1,
      meeting_state: "none",
      meeting_url: null,
      owner_user_id: ANA,
      contact_id: contactId,
      contacts,
    };
    const chain = {
      select: (cols: string) => {
        expect(cols).toContain("contacts(name, display_name, is_blocked)");
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      in: () => chain,
      gte: () => chain,
      lt: () => chain,
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [linha], error: null }).then(res),
    };
    return { from: () => chain } as unknown as SupabaseClient;
  }
  async function bloqueado(contactId: string | null, contacts: unknown) {
    const r = await listaAgendamentos(agendaCom(contactId, contacts), "org", { ownerUserId: ANA, limite: 20 });
    if (!r.ok) throw new Error(r.codigo);
    return r.agendamentos[0]!.contatoNaoRecebeMensagens;
  }

  it("nas duas formas do embed", async () => {
    expect(await bloqueado(CONTATO, { name: "Carla Fictícia", is_blocked: true })).toBe(true);
    expect(await bloqueado(CONTATO, [{ name: "Carla Fictícia", is_blocked: true }])).toBe(true);
    expect(await bloqueado(CONTATO, { name: "Carla Fictícia", is_blocked: false })).toBe(false);
    expect(await bloqueado(null, null)).toBe(false);
  });
});
