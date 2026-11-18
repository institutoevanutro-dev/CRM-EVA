/**
 * A campanha por dentro — auditoria de 17/11/2026, lote 2.
 *
 *  - item 14: o teste só lista contatos depois de digitar, confirma com o nome
 *    e diz quando saiu;
 *  - item 15: preparada, há "Voltar para rascunho";
 *  - item 17: duplicar abre a cópia;
 *  - item 18: o ritmo diz o erro embaixo do campo e não deixa salvar;
 *  - item 22: a lista de destinatários anda com a campanha;
 *  - item 23: fora do horário, "aguardando", não "Enviando 0%" mudo;
 *  - item 24: o problema da última preparação em frase, não em código;
 *  - item 25: rascunho sem quatro zeros, um botão cheio, cancelar com cor de
 *    perigo e a mensagem no balão com nome de exemplo.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DetalheDaCampanha } from "./_client";

const push = vi.fn();
const acao = vi.fn();
const editar = vi.fn();
const destinatarios = vi.fn();
const contatos = vi.fn();
let campanha: Record<string, unknown>;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "Número da clínica",
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [] }),
  useAgentesPublicados: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: (filtros: { search: string }, opcoes: { enabled?: boolean }) => {
    contatos(filtros, opcoes);
    return { isLoading: false, data: opcoes.enabled ? { pages: [{ data: [{ id: "k1", name: "Ana Teste" }] }] } : undefined };
  },
}));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCampanha: () => ({ isLoading: false, isError: false, data: campanha, refetch: vi.fn() }),
  useMetricasDaCampanha: () => ({
    data: {
      contagem: { enviados: 0, entregues: 0, responderam: 0, pendentes: 2, falharam: 0, optOut: 0 },
      progresso: 0,
    },
  }),
  useDestinatarios: (...args: unknown[]) => {
    destinatarios(...args);
    return { data: { pages: [{ data: [] }] }, hasNextPage: false };
  },
  useAcaoDeCampanha: () => ({ mutate: acao, isPending: false }),
  useEditarCampanha: () => ({ mutate: editar, isPending: false, isSuccess: false }),
}));

function aCampanha(extra: Record<string, unknown> = {}) {
  return {
    id: "c1",
    name: "Retorno de pacientes (fictícia)",
    status: "draft",
    channel_session_id: "canal",
    channel_session_ids: [],
    message_body: "Oi, {{primeiro_nome}}! Faz um ano da sua consulta.",
    base_legal: "consent",
    lia_ref: null,
    failure_code: null,
    snapshot_total: 0,
    snapshot_eligible: 0,
    intervalo_segundos: null,
    janela_inicio_hora: null,
    janela_fim_hora: null,
    teto_diario: null,
    teto_horario: null,
    janela_de_envio: { inicio: 7, fim: 22, aberta: true },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  campanha = aCampanha();
});

describe("enviar teste (item 14)", () => {
  beforeEach(() => {
    campanha = aCampanha({ status: "ready", snapshot_total: 2, snapshot_eligible: 2 });
  });

  it("não lista ninguém antes de digitar", () => {
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Enviar teste" }));

    expect(screen.queryByText("Ana Teste")).toBeNull();
    expect(contatos).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
  });

  it("pede confirmação com o nome e diz quando saiu", () => {
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Enviar teste" }));
    fireEvent.change(screen.getByLabelText("Contato do teste"), { target: { value: "An" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar para este" }));

    expect(acao).not.toHaveBeenCalled();
    expect(screen.getByText("Ana Teste", { selector: "strong" })).toBeTruthy();

    const enviar = screen.getAllByRole("button", { name: "Enviar teste" }).at(-1)!;
    fireEvent.click(enviar);
    expect(acao).toHaveBeenCalledWith({ acao: "testar", corpo: { contact_id: "k1" } }, expect.anything());

    // O servidor respondeu: o painel diz para quem saiu.
    const { onSuccess } = acao.mock.calls[0]![1] as { onSuccess: () => void };
    act(() => onSuccess());
    expect(screen.getByRole("status").textContent).toContain("Teste enviado para Ana Teste");
  });
});

describe("voltar para rascunho (item 15)", () => {
  it("aparece na campanha pronta e chama a ação", () => {
    campanha = aCampanha({ status: "ready", snapshot_total: 2, snapshot_eligible: 2 });
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Voltar para rascunho" }));
    expect(acao).toHaveBeenCalledWith({ acao: "rascunho" });
  });

  it("não aparece no rascunho", () => {
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.queryByRole("button", { name: "Voltar para rascunho" })).toBeNull();
  });
});

describe("duplicar (item 17)", () => {
  it("abre a cópia assim que ela existe", () => {
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));

    const { onSuccess } = acao.mock.calls[0]![1] as { onSuccess: (r: unknown) => void };
    onSuccess({ data: { id: "copia" } });
    expect(push).toHaveBeenCalledWith("/app/campaigns/copia");
  });
});

describe("ritmo (item 18)", () => {
  it("meia janela: diz o que falta e não deixa salvar", () => {
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.change(screen.getByLabelText("Enviar só a partir das (hora)"), { target: { value: "9" } });

    expect(screen.getByText("Preencha as duas horas, ou deixe as duas em branco.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar ritmo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("intervalo 0: diz o mínimo", () => {
    render(<DetalheDaCampanha id="c1" />);
    fireEvent.change(screen.getByLabelText("Intervalo mínimo entre mensagens (segundos)"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Use pelo menos 1 segundo.")).toBeTruthy();
  });
});

describe("a lista anda com a campanha (item 22)", () => {
  it("passa o estado da campanha para a consulta dos destinatários", () => {
    campanha = aCampanha({ status: "running", snapshot_total: 2, snapshot_eligible: 2 });
    render(<DetalheDaCampanha id="c1" />);
    expect(destinatarios).toHaveBeenLastCalledWith("c1", { status: undefined }, "running");
  });
});

describe("fora do horário (item 23)", () => {
  it("diz que espera e quando volta", () => {
    campanha = aCampanha({
      status: "running",
      snapshot_total: 2,
      snapshot_eligible: 2,
      janela_de_envio: { inicio: 7, fim: 22, aberta: false },
    });
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.getByRole("status").textContent).toBe("Aguardando o horário de envio. Volta às 7h.");
  });
});

describe("problema da última preparação (item 24)", () => {
  it("vira frase, não código", () => {
    campanha = aCampanha({ failure_code: "sem_elegiveis" });
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.queryByText(/sem_elegiveis/)).toBeNull();
    expect(screen.getByText(/nenhuma podia receber/)).toBeTruthy();
  });
});

describe("a tela da campanha (item 25)", () => {
  it("rascunho não mostra os quatro zeros", () => {
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.queryByText("Na lista")).toBeNull();
    expect(screen.queryByText("Progresso")).toBeNull();
  });

  it("um botão cheio (o passo seguinte) e cancelar com cor de perigo", () => {
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.getByRole("button", { name: "Preparar lista" }).className).toContain("bg-accent");
    expect(screen.getByRole("button", { name: "Duplicar" }).className).not.toContain("bg-accent");
    expect(screen.getByRole("button", { name: "Cancelar campanha" }).className).toContain("text-error-fg");
  });

  it("a mensagem aparece no balão com o nome de exemplo", () => {
    render(<DetalheDaCampanha id="c1" />);
    expect(screen.getByText(/Oi, Ana! Faz um ano/)).toBeTruthy();
    expect(screen.queryByText(/\{\{primeiro_nome\}\}/)).toBeNull();
  });
});
