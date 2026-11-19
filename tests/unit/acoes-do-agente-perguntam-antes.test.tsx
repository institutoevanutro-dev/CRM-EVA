/**
 * AÇÕES DO AGENTE QUE MUDAM O QUE O PACIENTE RECEBE PERGUNTAM ANTES — e dizem
 * o que muda (auditoria de 17/11, lote 1).
 *
 *   2. "Aplicar como versão nova" publicava com um clique, sem mostrar o trecho.
 *   5. O aviso do agente legado repetia, em texto livre, o formulário do editor.
 *   7. "Reverter" tirava do editor o rascunho em andamento sem avisar.
 *   8. "Publicar" dizia "Prompt: sem alteração" quando o texto mudava com o
 *      mesmo tamanho, e calava materiais, funis e horário.
 *  10. "Pausar" e Automático ↔ Assistido valiam com um clique.
 *
 * Nomes e textos são fictícios.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const AGENTE = "44444444-4444-4444-8444-444444444444";

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
const listaActions = vi.hoisted(() => ({ pausar: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: nav.refresh, replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({ revertToVersionAction: vi.fn() }));
vi.mock("@/app/app/ai/agents/_actions", () => ({
  pauseAgentAction: listaActions.pausar,
  unpauseAgentAction: vi.fn(),
  archiveAgentAction: vi.fn(),
  duplicateAgentAction: vi.fn(),
  renameAgentAction: vi.fn(),
}));

import { AgentOperation } from "@/app/app/ai/agents/[id]/_components/AgentOperation";
import { LegacyRecovery } from "@/app/app/ai/agents/[id]/_components/LegacyRecovery";
import { ProposalsPanel } from "@/app/app/ai/agents/[id]/_components/ProposalsPanel";
import { PublishConfirmDialog } from "@/app/app/ai/agents/[id]/_components/PublishConfirmDialog";
import { VersionHistory } from "@/app/app/ai/agents/[id]/_components/VersionHistory";
import { AgentRowMenu } from "@/app/app/ai/agents/_components/AgentRowMenu";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

function comProvedor(filho: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{filho}</QueryClientProvider>;
}

function versao(numero: number, status: string, campos: Partial<AgentVersionRow> = {}) {
  return {
    id: `00000000-0000-4000-8000-00000000000${numero}`,
    agent_id: AGENTE,
    version_number: numero,
    status,
    provider: "anthropic",
    model: "claude-sonnet-5",
    system_prompt: "Você é a Clara, recepção de uma clínica fictícia.",
    tool_ids: [],
    knowledge_source_ids: [],
    pipeline_ids: [],
    trigger_config: null,
    created_at: "2026-11-01T00:00:00Z",
    published_at: null,
    ...campos,
  } as unknown as AgentVersionRow;
}

const AGENTE_ROW = {
  id: AGENTE,
  name: "Clara",
  published_version_id: "v4",
  paused_at: null,
  operation_mode: "automatic",
  archived_at: null,
  is_default: false,
  kind: "mcp_agent",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
});

describe("item 2 — aplicar proposta pergunta, mostra o trecho e recarrega a tela", () => {
  const PROPOSTA = {
    id: "55555555-5555-4555-8555-555555555555",
    run_id: "r1",
    dataset: "d",
    type: "playbook_bullet",
    target: "prompt",
    content: "Antes de oferecer horário, pergunte se a paciente tem convênio.",
    evidence: {},
    proposed_at: "2026-11-17T12:00:00Z",
    applied_at: null,
    applied_version_id: null,
    applied_by: null,
  };

  beforeEach(() => {
    api.get.mockResolvedValue({ data: { items: [PROPOSTA] } });
  });

  it("nada vai ao ar no primeiro clique; o diálogo mostra o trecho e o rascunho que sai", async () => {
    const user = userEvent.setup();
    render(
      comProvedor(
        <ProposalsPanel agentId={AGENTE} active rascunhoVigente={versao(5, "draft")} />,
      ),
    );

    await user.click(await screen.findByRole("button", { name: "Aplicar como versão nova" }));
    expect(api.post, "publicou com um clique, sem confirmar").not.toHaveBeenCalled();

    const dialogo = await screen.findByRole("alertdialog");
    expect(within(dialogo).getByTestId("proposta-trecho")).toHaveTextContent(PROPOSTA.content);
    expect(dialogo).toHaveTextContent("vai ao ar agora");
    expect(dialogo).toHaveTextContent("O rascunho v5, ainda não publicado, sai do editor.");

    await user.click(within(dialogo).getByRole("button", { name: "Pôr no ar agora" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/api/v1/ai/agents/${AGENTE}/proposals/${PROPOSTA.id}/apply`,
        {},
      ),
    );
    // A Configuração precisa ler a versão nova, senão salvar desfaz a melhoria.
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it("com mudanças não salvas na Configuração, não deixa aplicar como versão nova", async () => {
    render(comProvedor(<ProposalsPanel agentId={AGENTE} active alteracoesNaoSalvas />));
    expect(await screen.findByRole("button", { name: "Aplicar como versão nova" })).toBeDisabled();
    expect(screen.getByText(/Salve ou descarte antes de aplicar/)).toBeInTheDocument();
  });
});

describe("item 5 — o aviso do agente legado não repete o formulário", () => {
  it("só explica e manda para o editor: sem campo de provedor, modelo, chave ou canal", () => {
    render(<LegacyRecovery hasVersion={false} />);
    const aviso = screen.getByRole("region", { name: "Recuperar agente legado" });
    expect(within(aviso).queryAllByRole("textbox"), "provedor e modelo em texto livre").toHaveLength(0);
    expect(within(aviso).queryAllByRole("combobox")).toHaveLength(0);
    expect(within(aviso).queryAllByRole("button")).toHaveLength(0);
    expect(aviso).toHaveTextContent("As instruções dele já estão no editor abaixo.");
  });
});

describe("item 7 — reverter avisa que o rascunho em andamento sai do editor", () => {
  it("o diálogo nomeia o rascunho e diz onde ele fica", async () => {
    const user = userEvent.setup();
    const v4 = versao(4, "published");
    const v5 = versao(5, "draft");
    render(comProvedor(<VersionHistory agentId={AGENTE} versions={[v5, v4]} rascunhoVigente={v5} />));

    await user.click(screen.getByRole("button", { name: "Voltar a esta versão" }));
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo, "o rascunho sumia do editor sem aviso").toHaveTextContent(
      "O rascunho v5, ainda não publicado, sai do editor. Ele fica no Histórico e pode ser aberto de novo.",
    );
  });

  it("com mudanças não salvas, reverter fica bloqueado e diz por quê", () => {
    const v4 = versao(4, "published");
    render(comProvedor(<VersionHistory agentId={AGENTE} versions={[v4]} alteracoesNaoSalvas />));
    expect(screen.getByRole("button", { name: "Voltar a esta versão" })).toBeDisabled();
    expect(screen.getByText(/Salve ou descarte antes de reverter/)).toBeInTheDocument();
  });
});

describe("item 8 — publicar lista o que muda, pelo conteúdo", () => {
  function abrir(draft: AgentVersionRow, published: AgentVersionRow | null) {
    render(
      <PublishConfirmDialog
        open
        onOpenChange={() => {}}
        draft={draft}
        published={published}
        materiais={[
          { id: "m1", name: "Tabela de valores" },
          { id: "m2", name: "Cardápio antigo" },
        ]}
        funis={[{ id: "f1", name: "Avaliação gratuita" }]}
        onConfirm={() => {}}
        isPending={false}
      />,
    );
    return screen.getByTestId("publicar-o-que-muda").textContent ?? "";
  }

  it("trocar um preço mantendo o tamanho do texto aparece como mudança", () => {
    const texto = abrir(
      versao(8, "draft", { system_prompt: "A avaliação custa R$ 300." }),
      versao(7, "published", { system_prompt: "A avaliação custa R$ 250." }),
    );
    expect(texto, "o diálogo dizia que nada mudou no prompt").not.toMatch(/sem alteração/);
    expect(texto).toContain("Instruções: texto alterado, com o mesmo tamanho");
  });

  it("nomeia materiais e funis que entram e saem, e avisa do horário", () => {
    const texto = abrir(
      versao(8, "draft", {
        knowledge_source_ids: ["m1"],
        pipeline_ids: ["f1"],
        trigger_config: {
          filters: { business_hours: { timezone: "America/Sao_Paulo", start: "08:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] } },
        },
      }),
      versao(7, "published", { knowledge_source_ids: ["m2"] }),
    );
    expect(texto).toContain("Materiais: + Tabela de valores · − Cardápio antigo");
    expect(texto).toContain("Funis: + Avaliação gratuita");
    expect(texto).toContain("Horário de atendimento: mudou");
  });

  it("o que não tem linha própria aparece pelo nome do cartão da tela", () => {
    const texto = abrir(
      versao(8, "draft", { max_steps: 12, followup: { enabled: true, flow_pointer_ids: [] } }),
      versao(7, "published", { max_steps: 10, followup: { enabled: false, flow_pointer_ids: [] } }),
    );
    expect(texto).toContain("Também muda: Freios de segurança, Follow-up");
  });

  it("versão idêntica diz que nada muda", () => {
    expect(abrir(versao(8, "draft"), versao(7, "published"))).toContain(
      "Nada muda em relação à versão publicada.",
    );
  });
});

describe("item 10 — pausar e trocar o modo perguntam, dizendo a consequência", () => {
  it("'Pausar automático' só pausa depois de confirmar", async () => {
    const user = userEvent.setup();
    render(<AgentOperation agent={AGENTE_ROW as never} />);

    await user.click(screen.getByRole("button", { name: "Pausar automático" }));
    expect(api.patch, "pausou com um clique").not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("A IA para de responder sozinha aos pacientes");

    await user.click(within(dialogo).getByRole("button", { name: "Pausar" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/api/v1/ai/agents/${AGENTE}`, {
        paused_at: expect.any(String),
      }),
    );
  });

  it("trocar para Automático pede confirmação; cancelar não muda nada", async () => {
    const user = userEvent.setup();
    render(<AgentOperation agent={{ ...AGENTE_ROW, operation_mode: "assisted" } as never} />);
    const seletor = screen.getByRole("combobox", { name: "Modo de operação" });

    await user.selectOptions(seletor, "automatic");
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Passar para Automático?");
    expect(dialogo).toHaveTextContent("sem revisão antes do envio");
    expect(api.patch).not.toHaveBeenCalled();

    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    expect(api.patch).not.toHaveBeenCalled();
    expect(seletor).toHaveValue("assisted");

    await user.selectOptions(seletor, "automatic");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Passar para Automático",
      }),
    );
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/api/v1/ai/agents/${AGENTE}`, {
        operation_mode: "automatic",
      }),
    );
  });

  it("'Pausar' no menu da lista também pergunta antes", async () => {
    const user = userEvent.setup();
    listaActions.pausar.mockResolvedValue({ ok: true });
    render(comProvedor(<AgentRowMenu agent={AGENTE_ROW as never} />));

    await user.click(screen.getByRole("button", { name: "Menu de ações" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pausar" }));
    expect(listaActions.pausar).not.toHaveBeenCalled();
    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("As mensagens novas ficam esperando a equipe.");

    await user.click(within(dialogo).getByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(listaActions.pausar).toHaveBeenCalledWith(AGENTE));
  });
});
