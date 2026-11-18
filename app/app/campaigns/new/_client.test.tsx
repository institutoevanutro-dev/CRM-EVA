/**
 * Nova campanha — auditoria de 17/11/2026, lote 2.
 *
 *  - item 16: a campanha nova nasce com os padrões da organização;
 *  - item 18: meia janela é dita na tela e não deixa salvar;
 *  - item 20: os textos salvos aparecem na hora de escrever;
 *  - item 25: a variável entra onde está o cursor, não no fim;
 *  - item 26: etiquetas são escolhidas das que os contatos têm, não digitadas.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NovaCampanha } from "./_client";

const criar = vi.fn();
let padroes: Record<string, unknown> | undefined;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org" }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: ["retorno", "vip"] }),
}));
vi.mock("@/hooks/campanhas/useConfiguracao", () => ({
  useConfiguracaoDeCampanhas: () => ({ data: padroes ? { configuracao: padroes, padrao: {} } : undefined }),
  useTextosSalvos: () => ({
    data: [{ id: "t1", name: "Retorno de consulta", body: "Oi! Vamos marcar seu retorno?", created_at: "" }],
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [{ id: "canal" }] }),
  channelLabel: () => "Número da clínica",
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useFunis: () => ({ data: [] }),
  useEtapas: () => ({ data: [] }),
  useAgentesPublicados: () => ({ data: [] }),
}));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCriarCampanha: () => ({ mutate: criar, isPending: false }),
  usePreviaDaAudiencia: () => ({ isPending: false, mutate: vi.fn() }),
}));

// Radix abre o menu no `pointerdown`, não no `click`.
const abrir = (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerId: 1 });

const valor = (rotulo: string) => (screen.getByLabelText(rotulo) as HTMLInputElement).value;

beforeEach(() => {
  vi.clearAllMocks();
  padroes = undefined;
});

describe("padrões da organização (item 16)", () => {
  it("a campanha nova já vem com o ritmo padrão", () => {
    padroes = {
      atribuicao_horas: 72,
      intervalo_segundos: 90,
      janela_inicio_hora: 9,
      janela_fim_hora: 18,
      teto_diario: 40,
      teto_horario: null,
    };
    render(<NovaCampanha />);

    expect(valor("Intervalo mínimo entre mensagens (segundos)")).toBe("90");
    expect(valor("Enviar só a partir das (hora)")).toBe("9");
    expect(valor("Parar de enviar às (hora)")).toBe("18");
    expect(valor("Máximo por dia")).toBe("40");
    expect(valor("Máximo por hora")).toBe("");
  });
});

describe("ritmo (item 18)", () => {
  it("só o início da janela: avisa e não deixa salvar", () => {
    render(<NovaCampanha />);
    fireEvent.change(screen.getByLabelText("Enviar só a partir das (hora)"), { target: { value: "9" } });

    expect(screen.getByText("Preencha as duas horas, ou deixe as duas em branco.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar rascunho" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("mensagem (itens 20 e 25)", () => {
  it("usar um texto salvo preenche a mensagem", () => {
    render(<NovaCampanha />);
    abrir(screen.getByRole("button", { name: "Usar texto salvo" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retorno de consulta" }));

    expect(valor("Texto da mensagem")).toBe("Oi! Vamos marcar seu retorno?");
  });

  it("a variável entra onde está o cursor", () => {
    render(<NovaCampanha />);
    const campo = screen.getByLabelText("Texto da mensagem") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "Oi, tudo bem?" } });
    campo.setSelectionRange(4, 4);
    fireEvent.click(screen.getByRole("button", { name: "{{primeiro_nome}}" }));

    expect(campo.value).toBe("Oi, {{primeiro_nome}}tudo bem?");
  });
});

describe("etiquetas do público (item 26)", () => {
  it("são escolhidas das que os contatos têm — não há campo de digitar", () => {
    render(<NovaCampanha />);
    expect(screen.queryByPlaceholderText("separe por vírgula")).toBeNull();

    abrir(screen.getByRole("button", { name: /Com alguma destas etiquetas/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "vip" }));
    // O menu fica aberto para escolher a segunda; Esc fecha (modal esconde o resto).
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.getByRole("button", { name: /Com alguma destas etiquetas/ }).textContent).toContain("vip");
  });
});
