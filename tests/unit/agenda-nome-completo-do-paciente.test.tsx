/**
 * NOME COMPLETO DO PACIENTE NA MARCAÇÃO.
 *
 * O prontuário abre o atendimento pelo nome do CADASTRO (`contacts.name`) e
 * recusa sem ele, de propósito. O defeito estava na origem: consultas eram
 * marcadas para quem só tinha o nome do WhatsApp (`display_name`).
 *
 * O que não pode se perder:
 *   1. a RÉGUA: nome completo é nome e sobrenome, nunca identificador técnico,
 *      e só `name` conta (o do WhatsApp é sugestão, não cadastro);
 *   2. o MODAL: paciente sem nome completo ganha o campo, já com o nome do
 *      WhatsApp; uma palavra só não libera o Confirmar; o nome é gravado ANTES
 *      do agendamento, pela rota da ficha; quem tem nome não vê campo nenhum;
 *   3. o que NÃO passa pelo modal (IA, API, Google) não é barrado: a grade
 *      marca o compromisso e o painel dele completa o nome.
 *
 * Nomes fictícios, de propósito.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { MarcacaoSimples } from "@/components/agenda/MarcacaoSimples";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";
import { listaAgendamentos } from "@/lib/agenda/consulta";
import { ApiError } from "@/lib/api/types";
import {
  ehNomeCompleto,
  faltaNomeCompleto,
  sugestaoDeNomeCompleto,
} from "@/lib/contacts/rotulo-do-contato";

const ANA = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const PESSOAS = [{ id: ANA, nome: "Dra. Ana Teste", trilha: 1 }] as unknown as Pessoa[];
const TIPOS = [
  { id: "t-ana", nome: "Avaliação facial", duracaoMin: 45, donoId: ANA, localDetalhes: null },
];
const INSTANTE = "2026-10-22T16:00:00.000Z";

type Contato = {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
};

let contatoNoBanco: Contato | null = null;
let ordem: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  ordem = [];
  contatoNoBanco = null;
  api.get.mockImplementation(async (url: string) =>
    url.includes(`contact_id=${CONTATO}`) && contatoNoBanco
      ? { data: { contacts: [contatoNoBanco], conversations: [] } }
      : { data: { contacts: [], conversations: [] } },
  );
  api.patch.mockImplementation(async (url: string, corpo: unknown) => {
    ordem.push(`patch ${url} ${JSON.stringify(corpo)}`);
    return { data: {} };
  });
});
afterEach(cleanup);

describe("a régua do nome completo", () => {
  it("nome e sobrenome passam; uma palavra, emoji ou identificador técnico, não", () => {
    expect(ehNomeCompleto("Carla Fictícia")).toBe(true);
    expect(ehNomeCompleto("  Ana   de Souza  ")).toBe(true);
    expect(ehNomeCompleto("Carla")).toBe(false);
    expect(ehNomeCompleto("Carla 🌸")).toBe(false);
    expect(ehNomeCompleto("Contato 543134@lid")).toBe(false);
    expect(ehNomeCompleto("Contato 900928")).toBe(false);
    expect(ehNomeCompleto("")).toBe(false);
    expect(ehNomeCompleto(null)).toBe(false);
  });

  it("só o nome do CADASTRO conta: o do WhatsApp completo não basta", () => {
    expect(faltaNomeCompleto({ name: null })).toBe(true);
    expect(faltaNomeCompleto({ name: "Carla" })).toBe(true);
    expect(faltaNomeCompleto({ name: "Carla Fictícia" })).toBe(false);
  });

  it("a sugestão é o nome do WhatsApp quando ele já parece completo, senão o que a tela mostra", () => {
    expect(sugestaoDeNomeCompleto({ name: null, display_name: "Carla Fictícia" })).toBe(
      "Carla Fictícia",
    );
    expect(sugestaoDeNomeCompleto({ name: "Carla", display_name: "Carla Fictícia" })).toBe(
      "Carla Fictícia",
    );
    expect(sugestaoDeNomeCompleto({ name: "Carla", display_name: "Mãe 🌸" })).toBe("Carla");
    expect(sugestaoDeNomeCompleto({ name: null, display_name: "Contato 543134@lid" })).toBe("");
    expect(sugestaoDeNomeCompleto(null)).toBe("");
  });
});

/** O banco como `listaAgendamentos` o lê: uma consulta encadeada a `calendar_appointments`. */
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
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    gte: () => chain,
    lt: () => chain,
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: [linha], error: null }).then(res),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("a listagem da agenda diz quem está sem nome completo (leitura computada, sem schema)", () => {
  async function marcado(contactId: string | null, contacts: unknown) {
    const r = await listaAgendamentos(agendaCom(contactId, contacts), "org", {
      ownerUserId: ANA,
      limite: 20,
    });
    if (!r.ok) throw new Error(r.codigo);
    return r.agendamentos[0]!.contatoSemNomeCompleto;
  }

  it("só com o nome do WhatsApp: marcado, nas duas formas do embed", async () => {
    expect(await marcado(CONTATO, { name: null, display_name: "Carla Fictícia" })).toBe(true);
    expect(await marcado(CONTATO, [{ name: "Carla", display_name: "Carla" }])).toBe(true);
  });

  it("com nome completo no cadastro, ou sem cliente, nada a avisar", async () => {
    expect(await marcado(CONTATO, { name: "Carla Fictícia", display_name: "Carla" })).toBe(false);
    expect(await marcado(null, null)).toBe(false);
  });
});

function montarMarcacao(props: Partial<ComponentProps<typeof MarcacaoSimples>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onConfirmar = vi.fn(async () => {
    ordem.push("agendar");
  });
  const base: ComponentProps<typeof MarcacaoSimples> = {
    ancora: new Date(2026, 9, 22, 12),
    agora: new Date(2026, 9, 22, 8),
    usuarioId: ANA,
    pessoas: PESSOAS,
    tipos: TIPOS,
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
    onConfirmar,
    onVerNaAgenda: vi.fn(),
  };
  render(
    <QueryClientProvider client={qc}>
      <MarcacaoSimples {...base} {...props} />
    </QueryClientProvider>,
  );
  return { onConfirmar };
}

describe("Novo agendamento: paciente sem nome completo", () => {
  it("mostra o campo com o nome do WhatsApp, grava o nome e DEPOIS agenda", async () => {
    contatoNoBanco = {
      id: CONTATO,
      name: null,
      display_name: "Carla Fictícia",
      phone_number: "+5527999990000",
    };
    const { onConfirmar } = montarMarcacao();

    const campo = (await screen.findByTestId("campo-nome-completo")) as HTMLInputElement;
    expect(campo.value).toBe("Carla Fictícia");
    // A recepção confere e completa: o que ela digitar é o que vai para o cadastro.
    fireEvent.change(campo, { target: { value: "  Carla   Fictícia Souza " } });
    const confirmar = screen.getByTestId("confirmar-marcacao");
    expect(confirmar).toBeEnabled();

    fireEvent.click(confirmar);
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(ordem).toEqual([
      `patch /api/v1/contacts/${CONTATO} ${JSON.stringify({ name: "Carla Fictícia Souza" })}`,
      "agendar",
    ]);
    await screen.findByTestId("ver-na-agenda");
  });

  it("nome de uma palavra só não libera o Confirmar, e o rodapé diz por quê", async () => {
    contatoNoBanco = { id: CONTATO, name: null, display_name: "Carla", phone_number: null };
    const { onConfirmar } = montarMarcacao();

    const campo = (await screen.findByTestId("campo-nome-completo")) as HTMLInputElement;
    expect(campo.value).toBe("Carla");
    expect(campo).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("confirmar-marcacao")).toBeDisabled();
    expect(screen.getByTestId("falta-nome-na-marcacao").textContent).toBe(
      "Complete o nome do paciente para marcar.",
    );

    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    expect(onConfirmar).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();

    fireEvent.change(campo, { target: { value: "Carla Fictícia" } });
    expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled();
    expect(screen.queryByTestId("falta-nome-na-marcacao")).toBeNull();
  });

  it("gravação do nome recusada: nada é marcado, e a recusa aparece", async () => {
    contatoNoBanco = {
      id: CONTATO,
      name: null,
      display_name: "Carla Fictícia",
      phone_number: null,
    };
    api.patch.mockRejectedValue(
      new ApiError(403, "forbidden", undefined, "r", "Sem permissão para editar o contato."),
    );
    const { onConfirmar } = montarMarcacao();

    await screen.findByTestId("campo-nome-completo");
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));

    expect((await screen.findByTestId("recusa-da-marcacao")).textContent).toContain(
      "Sem permissão para editar o contato.",
    );
    expect(onConfirmar).not.toHaveBeenCalled();
  });

  it("paciente com nome completo no cadastro não vê campo nenhum e agenda direto", async () => {
    contatoNoBanco = {
      id: CONTATO,
      name: "Carla Fictícia",
      display_name: "Carlinha",
      phone_number: null,
    };
    const { onConfirmar } = montarMarcacao();

    await waitFor(() => expect(screen.getByTestId("confirmar-marcacao")).toBeEnabled());
    expect(screen.queryByTestId("campo-nome-completo")).toBeNull();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("compromisso pessoal, sem cliente, continua igual", async () => {
    const { onConfirmar } = montarMarcacao({ contactId: "" });

    expect(screen.getByTestId("sem-paciente")).toBeInTheDocument();
    expect(screen.queryByTestId("campo-nome-completo")).toBeNull();
    fireEvent.click(screen.getByTestId("confirmar-marcacao"));
    await waitFor(() => expect(onConfirmar).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe("marcado sem passar pelo modal (IA, API, Google): a grade avisa", () => {
  const base: Agendamento = {
    id: "ag-ia",
    titulo: "Avaliação facial",
    quemSeraAtendido: "Carla",
    responsavelId: ANA,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T13:45:00-03:00",
    origem: "ui",
    situacao: "confirmed",
  };

  function grade(agendamentos: Agendamento[]) {
    render(
      <GradeDaAgenda
        visao="semana"
        ancora={new Date("2026-09-16T12:00:00-03:00")}
        agora={new Date("2026-09-16T12:00:00-03:00")}
        fuso="America/Sao_Paulo"
        agendamentos={agendamentos}
        pessoas={PESSOAS}
      />,
    );
  }

  it("o bloco do paciente sem nome completo vem marcado, para quem vê e para quem ouve", () => {
    grade([{ ...base, faltaNomeCompleto: true }]);
    const bloco = screen.getByTestId("agendamento-ag-ia");
    expect(bloco).toHaveAttribute("data-falta-nome", "true");
    expect(bloco).toHaveAttribute("title", "Falta o nome completo");
    expect(bloco.getAttribute("aria-label")).toContain("falta o nome completo");
    expect(screen.getByTestId("falta-nome-ag-ia")).toBeInTheDocument();
  });

  it("quem tem nome completo não ganha aviso", () => {
    grade([{ ...base, faltaNomeCompleto: false }]);
    const bloco = screen.getByTestId("agendamento-ag-ia");
    expect(bloco).not.toHaveAttribute("data-falta-nome");
    expect(bloco.getAttribute("aria-label")).not.toContain("falta o nome completo");
    expect(screen.queryByTestId("falta-nome-ag-ia")).toBeNull();
  });
});

describe("o painel do compromisso completa o nome", () => {
  const compromisso = {
    id: "ag-ia",
    title: "Avaliação facial",
    notes: null,
    description: null,
    location_kind: null,
    location_details: null,
    starts_at: "2026-09-02T12:00:00Z",
    ends_at: "2026-09-02T12:45:00Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    contact_id: CONTATO,
    contato: { name: null, display_name: "Carla Fictícia" },
    conversation_id: null,
    outcome_source_kind: null,
    outcome_recorded_at: null,
    recovery: null,
    evidence_messages: [],
  };

  function abrir(podeCompletarNome: boolean) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <DetalheDoCompromisso id="ag-ia" onClose={() => {}} podeCompletarNome={podeCompletarNome} />
      </QueryClientProvider>,
    );
  }

  it("avisa, oferece o nome do WhatsApp e grava pela rota da ficha", async () => {
    api.get.mockResolvedValue({ data: compromisso });
    abrir(true);

    const aviso = await screen.findByTestId("falta-nome-completo");
    expect(aviso.textContent).toContain("Falta o nome completo");
    const campo = screen.getByTestId("campo-nome-completo") as HTMLInputElement;
    expect(campo.value).toBe("Carla Fictícia");

    fireEvent.change(campo, { target: { value: "Carla" } });
    expect(screen.getByTestId("salvar-nome-completo")).toBeDisabled();
    fireEvent.change(campo, { target: { value: "Carla Fictícia Souza" } });
    fireEvent.click(screen.getByTestId("salvar-nome-completo"));

    await waitFor(() =>
      expect(ordem).toEqual([
        `patch /api/v1/contacts/${CONTATO} ${JSON.stringify({ name: "Carla Fictícia Souza" })}`,
      ]),
    );
  });

  it("sem permissão de editar contato, o aviso aparece sem o campo", async () => {
    api.get.mockResolvedValue({ data: compromisso });
    abrir(false);

    await screen.findByTestId("falta-nome-completo");
    expect(screen.queryByTestId("campo-nome-completo")).toBeNull();
  });

  it("com nome completo no cadastro, nada a avisar", async () => {
    api.get.mockResolvedValue({
      data: { ...compromisso, contato: { name: "Carla Fictícia", display_name: "Carla" } },
    });
    abrir(true);

    await screen.findByTestId("compromisso-horario");
    expect(screen.queryByTestId("falta-nome-completo")).toBeNull();
  });

  it("compromisso cancelado não pede nome: não vai haver atendimento", async () => {
    api.get.mockResolvedValue({ data: { ...compromisso, status: "cancelled" } });
    abrir(true);

    await screen.findByTestId("compromisso-horario");
    expect(screen.queryByTestId("falta-nome-completo")).toBeNull();
  });
});
