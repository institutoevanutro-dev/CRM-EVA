/**
 * O painel do paciente (decisão 6 do André, 27/11/2026): a cara da janela de
 * marcação, três botões grandes, Compareceu/Faltou depois do horário e "Mais
 * detalhes" fechado. Remarcar usa o MESMO "quando" da marcação e manda
 * `starts_at` pela rota de sempre. Nomes fictícios.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DetalheDoCompromisso, type RemarcacaoDoPainel } from "@/components/agenda/DetalheDoCompromisso";
import type { HorarioLivre } from "@/components/agenda/tipos";
import { ApiError } from "@/lib/api/types";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
const avisos = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: avisos }));
/**
 * O dublê do Dialog faz com o Esc o que o Radix faz: chama `onEscapeKeyDown` e,
 * se ninguém impediu, fecha (`onOpenChange(false)`).
 */
const dialogo = vi.hoisted(() => ({ onOpenChange: (_aberto: boolean) => {} }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (aberto: boolean) => void;
  }) => {
    dialogo.onOpenChange = onOpenChange;
    return open ? <div>{children}</div> : null;
  },
  DialogContent: ({
    children,
    "data-testid": id,
    onEscapeKeyDown,
  }: {
    children: React.ReactNode;
    "data-testid"?: string;
    onEscapeKeyDown?: (e: KeyboardEvent) => void;
  }) => (
    <div
      role="dialog"
      data-testid={id}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        onEscapeKeyDown?.(e.nativeEvent);
        if (!e.nativeEvent.defaultPrevented) dialogo.onOpenChange(false);
      }}
    >
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

const ID = "11111111-0000-4000-8000-0000000000aa";
const H14: HorarioLivre = { instante: "2030-03-06T17:00:00.000Z", rotulo: "14:00" };
const BASE = {
  id: ID,
  title: "Aplicação de vitamina D",
  notes: "Trazer os exames",
  description: null,
  location_kind: "in_person",
  location_details: "Sala 2",
  starts_at: "2030-03-06T13:00:00Z",
  ends_at: "2030-03-06T13:30:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  revision: 1,
  excluded_at: null,
  exclusion_reason: null,
  booking_channel: "mensagem",
  created_by_kind: "user",
  converted_by_kind: null,
  converted_by_user_id: null,
  contact_id: "c-1",
  contato: { name: "Carla Fictícia Souza", display_name: null },
  conversation_id: "conv-1",
  outcome_source_kind: null,
  outcome_recorded_at: null,
  recovery: null,
  evidence_messages: [],
};

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

function detalhe(dados: Record<string, unknown>) {
  api.get.mockImplementation((url: string) =>
    Promise.resolve(url.includes("/pessoas") ? { data: [] } : { data: dados }),
  );
}

function Painel({
  onAbrir = vi.fn(),
  onFechar = vi.fn(),
  onClose = () => {},
  semLembrete,
  podeEditar = true,
  abertaDeInicio = false,
}: {
  onAbrir?: (c: string) => void;
  onFechar?: () => void;
  onClose?: () => void;
  semLembrete?: string;
  podeEditar?: boolean;
  /** O Remarcar já pedido (o `abrirCompromisso(id, true)` da página). */
  abertaDeInicio?: boolean;
}) {
  const [aberta, setAberta] = useState(abertaDeInicio);
  const remarcacao: RemarcacaoDoPainel = {
    aberta,
    onAbrir: (c) => {
      onAbrir(c);
      setAberta(true);
    },
    onFechar: () => {
      onFechar();
      setAberta(false);
    },
    semLembrete,
    quando: {
      ancora: new Date(2030, 2, 6, 12),
      agora: new Date(2030, 2, 1, 9),
      fuso: "America/Sao_Paulo",
      horariosPorDia: { "2030-03-06": [H14] },
      publicouHorarios: true,
      erroAoCarregar: false,
      fusoSuposto: false,
      onMesVisivel: () => {},
      mesCarregado: new Date(2030, 2, 1),
      temTipo: true,
      avisoSemTipo: "Carregando…",
      permiteEncaixe: true,
      abriuComHorario: false,
    },
  };
  return (
    <DetalheDoCompromisso
      id={ID}
      onClose={onClose}
      profissional="Dra. Ana Teste"
      remarcacao={remarcacao}
      podeEditar={podeEditar}
      podeExcluir
    />
  );
}

function abrir(ui: React.ReactNode = <Painel />) {
  render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </IdiomaProvider>,
  );
}

describe("painel do paciente", () => {
  it("cabeçalho: iniciais, nome do paciente, estado; embaixo procedimento, hora, profissional e local", async () => {
    detalhe(BASE);
    abrir();
    expect(await screen.findByRole("heading", { name: "Carla Fictícia Souza" })).toBeInTheDocument();
    expect(screen.getByText("CS")).toBeInTheDocument();
    expect(screen.getByTestId("estado-do-compromisso")).toHaveTextContent("Agendado");
    expect(screen.getByTestId("compromisso-procedimento")).toHaveTextContent("Aplicação de vitamina D");
    expect(screen.getByText("Dra. Ana Teste")).toBeInTheDocument();
    expect(screen.getByTestId("compromisso-local")).toHaveTextContent("Sala 2");
  });

  it("Confirmar só quando aguarda confirmação, e manda status confirmed com a revision", async () => {
    detalhe({ ...BASE, status: "pending" });
    api.patch.mockResolvedValue({ data: { id: ID } });
    abrir();
    fireEvent.click(await screen.findByTestId("acao-confirmar"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", { id: ID, revision: 1, status: "confirmed" }),
    );
  });

  it("já agendado: sem Confirmar, com Remarcar e Cancelar", async () => {
    detalhe(BASE);
    abrir();
    await screen.findByTestId("acao-remarcar");
    expect(screen.queryByTestId("acao-confirmar")).toBeNull();
    expect(screen.getByTestId("acao-cancelar")).toBeInTheDocument();
  });

  it("Remarcar abre o 'quando' no painel e manda starts_at pela rota de sempre", async () => {
    detalhe(BASE);
    api.patch.mockResolvedValue({ data: { id: ID } });
    const onAbrir = vi.fn();
    const onFechar = vi.fn();
    abrir(<Painel onAbrir={onAbrir} onFechar={onFechar} />);
    fireEvent.click(await screen.findByTestId("acao-remarcar"));
    expect(onAbrir).toHaveBeenCalledWith(BASE.starts_at);
    const quando = await screen.findByTestId("quando-da-marcacao");
    expect(screen.queryByTestId("aviso-sem-lembrete")).toBeNull();
    expect(screen.getByTestId("confirmar-remarcacao")).toBeDisabled();
    fireEvent.click(within(quando).getByTestId("horario-14:00"));
    expect(within(quando).getByTestId("hora-da-marcacao")).toHaveValue("14:00");
    fireEvent.click(screen.getByTestId("confirmar-remarcacao"));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", {
        id: ID,
        revision: 1,
        starts_at: H14.instante,
      }),
    );
    await waitFor(() => expect(onFechar).toHaveBeenCalled());
  });

  it("Cancelar abre o motivo; o botão só libera com 3 letras e chama a rota atual", async () => {
    detalhe(BASE);
    api.delete.mockResolvedValue({});
    abrir();
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    const confirmar = screen.getByTestId("confirmar-cancelamento");
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "ok" } });
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith("/api/v1/agenda/agendamentos", {
        id: ID,
        revision: 1,
        reason: "Pediu outro dia",
      }),
    );
  });

  it("Compareceu/Faltou só depois do início, e nunca em compromisso pessoal", async () => {
    detalhe(BASE);
    abrir();
    await screen.findByTestId("acao-cancelar");
    expect(screen.queryByRole("button", { name: "Compareceu" })).toBeNull();
    // O cache do detalhe sobreviveria ao `cleanup` e mostraria o compromisso anterior.
    cleanup();
    client.clear();

    detalhe({ ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" });
    abrir();
    expect(await screen.findByRole("button", { name: "Compareceu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Faltou" })).toBeInTheDocument();
    cleanup();
    client.clear();

    detalhe({ ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z", contact_id: null, contato: null });
    abrir();
    await screen.findByTestId("acao-cancelar");
    expect(screen.queryByRole("button", { name: "Compareceu" })).toBeNull();
  });

  it("'Mais detalhes' começa fechado e guarda contato, conversa, anotação e excluir", async () => {
    detalhe(BASE);
    abrir();
    const mais = (await screen.findByTestId("mais-detalhes-do-compromisso")) as HTMLDetailsElement;
    expect(mais.open).toBe(false);
    expect(within(mais).getByText("Ver contato").closest("a")).toHaveAttribute("href", "/app/contacts/c-1");
    expect(within(mais).getByText("Ver conversa").closest("a")).toHaveAttribute("href", "/app/inbox?id=conv-1");
    expect(within(mais).getByTestId("compromisso-anotacao")).toHaveTextContent("Trazer os exames");
    expect(within(mais).getByTestId("excluir-compromisso")).toBeInTheDocument();
  });

  it("falha do Meet abre 'Mais detalhes' sozinha: o aviso que a Central aponta não fica escondido", async () => {
    detalhe({
      ...BASE,
      meeting: {
        state: "failed",
        url: null,
        request_id: "req-1",
        error: "google_failure",
        delivery_state: "none",
        can_manage: true,
        destinations: [],
      },
    });
    abrir();
    const mais = (await screen.findByTestId("mais-detalhes-do-compromisso")) as HTMLDetailsElement;
    expect(mais.open).toBe(true);
    expect(within(mais).getByRole("alert")).toHaveTextContent("O Google não conseguiu criar o link.");
  });

  it("compromisso cancelado não oferece ação nenhuma", async () => {
    detalhe({ ...BASE, status: "cancelled" });
    abrir();
    expect(await screen.findByTestId("estado-do-compromisso")).toHaveTextContent("Cancelado");
    expect(screen.queryByTestId("acao-remarcar")).toBeNull();
    expect(screen.queryByTestId("acao-cancelar")).toBeNull();
  });

  it("Remarcar avisa que o lembrete não sai para quem pediu para não receber mensagens", async () => {
    detalhe(BASE);
    abrir(<Painel semLembrete="Carla Fictícia Souza" />);
    fireEvent.click(await screen.findByTestId("acao-remarcar"));
    const aviso = within(screen.getByTestId("remarcar-no-painel")).getByTestId("aviso-sem-lembrete");
    expect(aviso).toHaveTextContent("Carla Fictícia Souza pediu para não receber mensagens.");
    expect(aviso).toHaveTextContent("combine por telefone");
  });

  it("Esc com Cancelar ou Remarcar aberto fecha só a seção e guarda o texto; o segundo Esc fecha o painel", async () => {
    detalhe(BASE);
    const onClose = vi.fn();
    const onFechar = vi.fn();
    abrir(<Painel onClose={onClose} onFechar={onFechar} />);
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(screen.queryByTestId("cancelar-no-painel")).toBeNull();
    expect(screen.getByTestId("acao-cancelar")).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("acao-cancelar"));
    expect(screen.getByLabelText("Motivo do cancelamento")).toHaveValue("Pediu outro dia");

    fireEvent.click(screen.getByTestId("acao-remarcar"));
    await screen.findByTestId("remarcar-no-painel");
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(screen.queryByTestId("remarcar-no-painel")).toBeNull();
    expect(onFechar).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("remarcar depois de digitar um motivo não acusa 'o compromisso mudou' pela própria remarcação", async () => {
    detalhe(BASE);
    // Depois do PATCH a rota devolve a revisão nova, com o horário novo.
    api.patch.mockImplementation(async () => {
      detalhe({ ...BASE, revision: 2, starts_at: H14.instante, ends_at: "2030-03-06T17:30:00.000Z" });
      return { data: { id: ID } };
    });
    const onFechar = vi.fn();
    abrir(<Painel onFechar={onFechar} />);
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.click(screen.getByTestId("acao-remarcar"));
    fireEvent.click(within(await screen.findByTestId("quando-da-marcacao")).getByTestId("horario-14:00"));
    fireEvent.click(screen.getByTestId("confirmar-remarcacao"));
    await waitFor(() => expect(onFechar).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("compromisso-horario")).toHaveTextContent("14:00"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rascunho defasado também trava o Confirmar remarcação", async () => {
    detalhe({ ...BASE, status: "pending" });
    api.patch.mockRejectedValue(new ApiError(409, "conflict", undefined, "req", "O compromisso mudou."));
    abrir();
    fireEvent.click(await screen.findByTestId("acao-remarcar"));
    fireEvent.click(within(await screen.findByTestId("quando-da-marcacao")).getByTestId("horario-14:00"));
    expect(screen.getByTestId("confirmar-remarcacao")).toBeEnabled();
    fireEvent.click(screen.getByTestId("acao-confirmar"));
    await screen.findByRole("alert");
    expect(screen.getByTestId("confirmar-remarcacao")).toBeDisabled();
  });

  it("foco e estado: o motivo ganha o foco, o Voltar devolve ao botão, e os botões abrem e fecham", async () => {
    detalhe(BASE);
    abrir();
    const cancelar = await screen.findByTestId("acao-cancelar");
    fireEvent.click(cancelar);
    expect(screen.getByLabelText("Motivo do cancelamento")).toHaveFocus();
    expect(cancelar).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(screen.getByTestId("cancelar-no-painel")).getByRole("button", { name: "Voltar" }));
    expect(cancelar).toHaveFocus();
    expect(cancelar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(cancelar);
    fireEvent.click(cancelar);
    expect(screen.queryByTestId("cancelar-no-painel")).toBeNull();
    expect(cancelar).toHaveAttribute("aria-expanded", "false");

    const remarcar = screen.getByTestId("acao-remarcar");
    fireEvent.click(remarcar);
    expect(remarcar).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(screen.getByTestId("remarcar-no-painel")).getByRole("button", { name: "Voltar" }));
    expect(remarcar).toHaveFocus();
    expect(remarcar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(remarcar);
    fireEvent.click(remarcar);
    expect(screen.queryByTestId("remarcar-no-painel")).toBeNull();
    expect(remarcar).toHaveAttribute("aria-expanded", "false");
  });

  it("depois de cancelar, um Esc só fecha o painel", async () => {
    detalhe(BASE);
    // Depois do DELETE a rota devolve o compromisso cancelado.
    api.delete.mockImplementation(async () => {
      detalhe({ ...BASE, status: "cancelled", revision: 2 });
      return {};
    });
    const onClose = vi.fn();
    abrir(<Painel onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.click(screen.getByTestId("confirmar-cancelamento"));
    await waitFor(() => expect(screen.getByTestId("estado-do-compromisso")).toHaveTextContent("Cancelado"));
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Realizado e Faltou não oferecem Cancelar: o bônus conta a consulta realizada, e cancelada some da grade", async () => {
    for (const [status, rotulo] of [
      ["completed", "Realizado"],
      ["no_show", "Faltou"],
    ] as const) {
      detalhe({ ...BASE, status, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" });
      abrir();
      expect(await screen.findByTestId("estado-do-compromisso")).toHaveTextContent(rotulo);
      expect(screen.queryByTestId("acao-cancelar")).toBeNull();
      expect(screen.queryByTestId("acoes-do-compromisso")).toBeNull();
      // A presença segue corrigível: quem marcou Faltou por engano troca para Compareceu.
      expect(screen.getByRole("button", { name: "Compareceu" })).toBeInTheDocument();
      cleanup();
      client.clear();
    }
  });

  it("Cancelar aberto quando a presença é registrada: a seção some e um Esc só fecha o painel", async () => {
    const passado = { ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" };
    detalhe(passado);
    api.patch.mockImplementation(async () => {
      detalhe({ ...passado, status: "completed", revision: 2, outcome_recorded_at: "2020-01-01T13:00:00Z" });
      return { data: { id: ID } };
    });
    const onClose = vi.fn();
    abrir(<Painel onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    expect(screen.getByTestId("cancelar-no-painel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Compareceu" }));
    await waitFor(() => expect(screen.getByTestId("estado-do-compromisso")).toHaveTextContent("Realizado"));
    expect(screen.queryByTestId("cancelar-no-painel")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cada decisão do painel avisa que valeu, num toast curto", async () => {
    const passado = { ...BASE, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" };
    api.patch.mockResolvedValue({ data: { id: ID } });
    api.delete.mockResolvedValue({});

    detalhe({ ...BASE, status: "pending" });
    abrir();
    fireEvent.click(await screen.findByTestId("acao-confirmar"));
    await waitFor(() => expect(avisos.success).toHaveBeenCalledWith("Horário confirmado"));
    cleanup();
    client.clear();

    detalhe(BASE);
    abrir();
    fireEvent.click(await screen.findByTestId("acao-cancelar"));
    fireEvent.change(screen.getByLabelText("Motivo do cancelamento"), { target: { value: "Pediu outro dia" } });
    fireEvent.click(screen.getByTestId("confirmar-cancelamento"));
    await waitFor(() => expect(avisos.success).toHaveBeenCalledWith("Consulta cancelada"));
    cleanup();
    client.clear();

    detalhe(passado);
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Faltou" }));
    await waitFor(() =>
      expect(avisos.success).toHaveBeenCalledWith("Marcado como falta — o horário volta a ficar livre"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Compareceu" }));
    await waitFor(() => expect(avisos.success).toHaveBeenCalledWith("Presença registrada"));
    expect(avisos.success).toHaveBeenCalledTimes(4);
  });

  it("Remarcar 'aberto' com a seção escondida não segura o Esc: um só fecha o painel", async () => {
    // Quem pode marcar mas não editar, chegando pelo Remarcar da página.
    detalhe(BASE);
    const onClose = vi.fn();
    abrir(<Painel onClose={onClose} podeEditar={false} abertaDeInicio />);
    await screen.findByTestId("estado-do-compromisso");
    expect(screen.queryByTestId("remarcar-no-painel")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    client.clear();

    // Cancelado por outra pessoa com o Remarcar aberto.
    detalhe({ ...BASE, status: "cancelled" });
    const onClose2 = vi.fn();
    abrir(<Painel onClose={onClose2} abertaDeInicio />);
    expect(await screen.findByTestId("estado-do-compromisso")).toHaveTextContent("Cancelado");
    expect(screen.queryByTestId("remarcar-no-painel")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("painel-do-compromisso"), { key: "Escape" });
    expect(onClose2).toHaveBeenCalledOnce();
  });
});
