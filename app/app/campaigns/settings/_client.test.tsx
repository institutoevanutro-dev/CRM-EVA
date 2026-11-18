/**
 * Ritmo de envio (configuração de campanhas) — auditoria de 17/11/2026, lote 2.
 *
 *  - item 27: falha de carga tem "Tentar novamente", não cinza eterno;
 *  - item 20: o texto salvo aparece inteiro, não cortado numa linha;
 *  - item 26: exemplos de clínica, não de outro ramo;
 *  - item 18: meia janela nos padrões é dita na tela e não deixa salvar.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfiguracaoDeCampanhas } from "./_client";

const refetch = vi.fn();
let configuracao: { isLoading: boolean; isError: boolean; data: unknown; refetch: typeof refetch };

const TEXTO_LONGO = "Oi! Faz um ano da sua última consulta.\nQuer agendar o retorno? Responda com o melhor dia.";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/campanhas/useConfiguracao", () => ({
  useConfiguracaoDeCampanhas: () => configuracao,
  useSalvarConfiguracao: () => ({ mutate: vi.fn(), isPending: false, isSuccess: false }),
  useTextosSalvos: () => ({
    isLoading: false,
    isError: false,
    data: [{ id: "t1", name: "Retorno de consulta", body: TEXTO_LONGO, created_at: "" }],
  }),
  useSalvarTexto: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useApagarTexto: () => ({ mutate: vi.fn(), isPending: false }),
  useExclusoes: () => ({ isLoading: false, isError: false, data: [] }),
  useExcluirNumero: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTirarDaExclusao: () => ({ mutate: vi.fn(), isPending: false }),
}));

const CONFIG = {
  atribuicao_horas: 72,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  configuracao = { isLoading: false, isError: false, data: { configuracao: CONFIG, padrao: CONFIG }, refetch };
});

describe("falha de carga (item 27)", () => {
  it("os padrões dizem que falharam e deixam tentar de novo", () => {
    configuracao = { isLoading: false, isError: true, data: undefined, refetch };
    render(<ConfiguracaoDeCampanhas />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("textos salvos (itens 20 e 26)", () => {
  it("aparecem inteiros", () => {
    render(<ConfiguracaoDeCampanhas />);
    const corpo = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === TEXTO_LONGO);
    expect(corpo.className).not.toContain("truncate");
  });

  it("o exemplo é de clínica", () => {
    render(<ConfiguracaoDeCampanhas />);
    expect(screen.getByPlaceholderText("Ex.: Retorno de consulta")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/produtor/)).toBeNull();
  });
});

describe("padrões de ritmo (item 18)", () => {
  it("meia janela avisa e não deixa salvar", () => {
    render(<ConfiguracaoDeCampanhas />);
    fireEvent.change(screen.getByLabelText("Parar de enviar às (hora)"), { target: { value: "20" } });

    expect(screen.getByText("Preencha as duas horas, ou deixe as duas em branco.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar padrões" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
