/**
 * O EDITOR DO AGENTE NÃO PERDE O QUE FOI ESCRITO (auditoria de 17/11, lote 1).
 *
 * Cada caso abaixo é um item do relatório, medido pela tela:
 *
 *   1. (P0) Trocar de aba apagava o prompt não salvo — a aba Configuração era
 *      desmontada pelo Radix — e o Teste rodava a versão salva sem avisar.
 *   2. Depois de "Aplicar proposta"/"Reverter", a Configuração seguia na versão
 *      velha, e o próximo "Salvar rascunho" desfazia o que acabara de ir ao ar.
 *   4. Um número fora da faixa deixava "Salvar rascunho" cinza sem dizer qual
 *      campo estava errado.
 *   5. O agente legado abria no texto padrão, e não nas instruções dele.
 *   6. Sair da tela com alterações não salvas perdia tudo sem aviso.
 *   7. O rascunho que o "Reverter" deixava para trás não abria mais.
 *
 * Nomes e textos são fictícios.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";

const acoes = vi.hoisted(() => ({
  salvar: vi.fn(),
  publicar: vi.fn(),
  criar: vi.fn(),
  reverter: vi.fn(),
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: acoes.salvar,
  publishAgentAction: acoes.publicar,
  createMcpAgentAction: acoes.criar,
  revertToVersionAction: acoes.reverter,
}));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import { AgentTabs } from "@/app/app/ai/agents/[id]/_components/AgentTabs";

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: ORG,
  name: "Clara",
  description: null,
  priority: 0,
  model: "claude-sonnet-5",
  system_prompt: "",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: "v4",
  paused_at: null,
  operation_mode: "automatic",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function versao(numero: number, status: string, prompt: string) {
  return {
    id: `00000000-0000-4000-8000-00000000000${numero}`,
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: numero,
    status,
    system_prompt: prompt,
    provider: "anthropic",
    model: "claude-sonnet-5",
    // `null` = a chave da instalação (o caso mais comum do kit).
    credential_id: null,
    tool_ids: [],
    channel_session_id: null,
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    cases_enabled: false,
    split_messages: false,
    split_max_chars: 600,
    reply_min_interval_ms: null,
    followup: { enabled: false, flow_pointer_ids: [] },
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    trigger_config: null,
    published_at: null,
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
  };
}

const PROMPT_V4 = "Você é a Clara, recepção de uma clínica fictícia. Atenda com calma.";
const PROMPT_NOVO = "Você é a Clara. Nunca diga preço; convide para a avaliação gratuita.";

function comProvedor(filho: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{filho}</QueryClientProvider>;
}

function formulario(props: Record<string, unknown>) {
  return (
    <AgentForm
      mode="edit"
      agent={AGENTE_ROW as never}
      credentials={[] as never}
      provedoresDaInstalacao={["anthropic"]}
      channelSessions={[] as never}
      draft={null}
      published={null}
      base={null}
      draftObsoleto={null}
      {...(props as object)}
    />
  );
}

const campoDoPrompt = () => screen.getByRole("textbox", { name: "As instruções dele" });
const botaoSalvar = () => screen.getByRole("button", { name: /salvar rascunho/i });

beforeEach(() => {
  vi.clearAllMocks();
  // Sem rede no teste: o que a tela busca sozinha (modelos, capacidades) falha
  // como falhava antes; só a versão pedida pelo Histórico responde.
  api.get.mockImplementation((caminho: string) => {
    const v3 = versao(3, "draft", "Rascunho antigo da Clara: perguntar o convênio antes do horário.");
    if (caminho === `/api/v1/ai/agents/${AGENTE}/versions/${v3.id}`) {
      return Promise.resolve({ data: v3 });
    }
    return Promise.reject(new Error("sem rede no teste"));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("item 1 (P0) — trocar de aba não apaga o prompt, e o Teste avisa", () => {
  it("vai ao Teste e volta com o texto que não foi salvo", async () => {
    const user = userEvent.setup();
    const v4 = versao(4, "published", PROMPT_V4);
    render(
      comProvedor(
        <AgentTabs
          agent={AGENTE_ROW as never}
          draft={null}
          published={v4 as never}
          base={v4 as never}
          draftObsoleto={null}
          versions={[v4] as never}
          credentials={[] as never}
          provedoresDaInstalacao={["anthropic"]}
          channelSessions={[] as never}
        />,
      ),
    );

    fireEvent.change(campoDoPrompt(), { target: { value: PROMPT_NOVO } });
    await user.click(screen.getByRole("tab", { name: "Teste" }));

    // O Teste roda a versão SALVA: com texto por salvar, ele diz e não roda.
    const aviso = await screen.findByTestId("teste-alteracoes-nao-salvas");
    expect(aviso).toHaveTextContent("O teste usa a versão salva.");
    const executar = screen.getByRole("button", { name: "Executar teste" });
    expect(executar, "o teste rodaria a versão velha como se fosse o texto da tela").toBeDisabled();
    expect(executar).toHaveAccessibleDescription(/salve o rascunho para testar/i);

    await user.click(within(aviso).getByRole("button", { name: "Ir para a Configuração" }));
    expect(campoDoPrompt(), "o prompt escrito sumiu ao trocar de aba").toHaveValue(PROMPT_NOVO);
    expect(botaoSalvar()).toBeEnabled();
  });

  it("sem nada por salvar, o Teste não mostra aviso nem trava", async () => {
    const user = userEvent.setup();
    const v4 = versao(4, "published", PROMPT_V4);
    render(
      comProvedor(
        <AgentTabs
          agent={AGENTE_ROW as never}
          draft={null}
          published={v4 as never}
          base={v4 as never}
          versions={[v4] as never}
          credentials={[] as never}
          provedoresDaInstalacao={["anthropic"]}
          channelSessions={[] as never}
        />,
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Teste" }));
    expect(screen.queryByTestId("teste-alteracoes-nao-salvas")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Executar teste" })).toBeEnabled();
  });
});

describe("item 2 — a Configuração acompanha a versão que foi ao ar por outra aba", () => {
  it("sem alteração local, troca para a versão nova e não fica 'com algo por salvar'", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    const v5 = versao(5, "published", `${PROMPT_V4}\n\n## Aprendizado do flywheel\n- Confirme o convênio.\n`);
    const { rerender } = render(comProvedor(formulario({ published: v4, base: v4 })));
    expect(campoDoPrompt()).toHaveValue(PROMPT_V4);

    // O que `router.refresh()` entrega depois de "Aplicar proposta".
    rerender(comProvedor(formulario({ published: v5, base: v5 })));

    expect(campoDoPrompt(), "a tela seguiu na versão velha").toHaveValue(v5.system_prompt);
    expect(botaoSalvar(), "salvar agora gravaria o texto velho por cima").toBeDisabled();
  });

  it("com alteração local, ela fica — nada some em silêncio", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    const v5 = versao(5, "published", `${PROMPT_V4} Confirme o convênio.`);
    const { rerender } = render(comProvedor(formulario({ published: v4, base: v4 })));
    fireEvent.change(campoDoPrompt(), { target: { value: PROMPT_NOVO } });

    rerender(comProvedor(formulario({ published: v5, base: v5 })));

    expect(campoDoPrompt()).toHaveValue(PROMPT_NOVO);
    expect(botaoSalvar()).toBeEnabled();
  });
});

describe("item 4 — número fora da faixa diz qual campo está errado", () => {
  it("30 em 'Ações por atendimento' mostra a faixa embaixo do campo, em português", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    render(comProvedor(formulario({ published: v4, base: v4 })));

    const campo = screen.getByLabelText("Ações por atendimento (1 a 25)");
    fireEvent.change(campo, { target: { value: "30" } });

    expect(campo).toHaveAttribute("aria-invalid", "true");
    expect(campo, "o botão ficava cinza sem dizer qual campo").toHaveAccessibleDescription(
      "Use um número de 1 a 25.",
    );
    expect(botaoSalvar()).toBeDisabled();
  });

  it("campo apagado (vira 0) também é explicado, e a mensagem some quando corrige", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    render(comProvedor(formulario({ published: v4, base: v4 })));
    const campo = screen.getByLabelText("Volume de texto por atendimento");

    fireEvent.change(campo, { target: { value: "" } });
    expect(campo).toHaveAccessibleDescription("Use um número de 1.000 a 500.000.");

    fireEvent.change(campo, { target: { value: "60000" } });
    expect(campo).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Use um número de 1.000 a 500.000.")).not.toBeInTheDocument();
    expect(botaoSalvar()).toBeEnabled();
  });
});

describe("item 5 — agente legado abre com as instruções dele", () => {
  it("sem versão nenhuma, o editor traz o prompt do legado, não o texto padrão", () => {
    const legado = "Você é a Lia, do consultório fictício Bem-Estar. Agende só de segunda a sexta.";
    render(
      comProvedor(
        formulario({
          agent: { ...AGENTE_ROW, kind: "rag_bot", published_version_id: null, system_prompt: legado },
        }),
      ),
    );
    expect(campoDoPrompt(), "concluir a configuração trocaria o prompt da clínica pelo genérico").toHaveValue(
      legado,
    );
  });
});

describe("item 6 — sair com alteração não salva pergunta antes", () => {
  it("fechar ou recarregar a aba e clicar num link do app pedem confirmação", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    render(comProvedor(formulario({ published: v4, base: v4 })));
    fireEvent.change(campoDoPrompt(), { target: { value: PROMPT_NOVO } });

    const fechar = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(fechar);
    expect(fechar.defaultPrevented, "fechar a aba perdia tudo sem aviso").toBe(true);

    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    const link = screen.getByRole("link", { name: "Cadastrar ou trocar credencial" });
    const seguiu = fireEvent.click(link);
    expect(confirmar).toHaveBeenCalledWith(expect.stringMatching(/^Sair sem salvar\?/));
    expect(seguiu, "o link trocou de tela por cima do que não foi salvo").toBe(false);
  });

  it("sem nada por salvar, sair não pergunta nada", () => {
    const v4 = versao(4, "published", PROMPT_V4);
    render(comProvedor(formulario({ published: v4, base: v4 })));

    const fechar = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(fechar);
    expect(fechar.defaultPrevented).toBe(false);

    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("link", { name: "Cadastrar ou trocar credencial" }));
    expect(confirmar).not.toHaveBeenCalled();
  });
});

describe("item 7 — o rascunho deixado para trás abre de novo no editor", () => {
  it("'Abrir no editor' no Histórico leva o texto dele para a Configuração, por salvar", async () => {
    const user = userEvent.setup();
    const v3 = versao(3, "draft", "Rascunho antigo da Clara: perguntar o convênio antes do horário.");
    const v4 = versao(4, "published", PROMPT_V4);
    render(
      comProvedor(
        <AgentTabs
          agent={AGENTE_ROW as never}
          draft={null}
          published={v4 as never}
          base={v4 as never}
          draftObsoleto={v3 as never}
          versions={[v4, v3] as never}
          credentials={[] as never}
          provedoresDaInstalacao={["anthropic"]}
          channelSessions={[] as never}
        />,
      ),
    );

    await user.click(screen.getByRole("tab", { name: "Histórico" }));
    await user.click(screen.getByRole("button", { name: "Abrir no editor" }));

    await waitFor(() => expect(campoDoPrompt()).toHaveValue(v3.system_prompt));
    expect(api.get).toHaveBeenCalledWith(`/api/v1/ai/agents/${AGENTE}/versions/${v3.id}`);
    // Entra como alteração: quem grava é o "Salvar rascunho" de sempre.
    expect(botaoSalvar()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Descartar alterações" })).toBeEnabled();
  });
});
