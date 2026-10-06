/**
 * A TELA do Painel do funil, montada com o hook dublado — o que a pessoa vê
 * quando o investimento falta, quando um Aplicar volta com erro e quando ela
 * troca o funil antes de escolher o campo do recorte.
 *
 * A rota e as contas têm os seus testes; aqui o que se prova é o que só o
 * componente decide: o texto de estado, o "—" no lugar de zero, e um
 * formulário que não perde as opções.
 *
 * Roda com: npx vitest run tests/unit/painel-do-funil-tela.test.tsx
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FiltrosDoPainel, PainelDoFunil } from "@/hooks/metrics/usePainelDoFunil";

const m = vi.hoisted(() => ({ consulta: vi.fn() }));
vi.mock("@/hooks/metrics/usePainelDoFunil", () => ({
  usePainelDoFunil: (f: FiltrosDoPainel) => m.consulta(f),
}));

// O Select do Radix pede estas APIs do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { PainelDoFunilClient } from "@/app/app/painel-do-funil/_components/PainelDoFunilClient";

const P = "funil-comercial";
const P2 = "funil-acompanhamento";

function painel(extra: Partial<PainelDoFunil> = {}): PainelDoFunil {
  return {
    periodo: { de: "2026-09-01", ate: "2026-09-30", fuso: "America/Sao_Paulo" },
    funil: { id: P, nome: "Comercial" },
    numeros: {
      leads: 3,
      interagiram: 1,
      taxa_interacao: 1 / 3,
      perdidos: 0,
      aviso_interacao: null,
      etapa_interacao: "Interagiu",
      ganhos: 2,
      receita: [{ moeda: "BRL", cents: "50000" }],
      sem_valor: 0,
      sem_moeda: 0,
      ganhos_de_anuncio: null,
      custo_por_venda_cents: null,
      roas: null,
      agendados: 0,
      realizados: 0,
      faltas: 0,
      sem_baixa: 0,
      cancelados: 0,
      taxa_comparecimento: null,
    },
    por_etapa: [],
    dimensao: null,
    investimento: { estado: "nao_conectado" },
    opcoes: {
      funis: [
        {
          id: P,
          nome: "Comercial",
          padrao: true,
          campos_card: [{ key: "modalidade", label: "Modalidade" }],
        },
        {
          id: P2,
          nome: "Acompanhamento",
          padrao: false,
          campos_card: [{ key: "convenio", label: "Convênio" }],
        },
      ],
      campos_contato: [{ key: "origem", label: "Origem" }],
    },
    truncado: false,
    ...extra,
  };
}

const sucesso = (data: PainelDoFunil) => ({
  data: { data },
  isLoading: false,
  isError: false,
  error: null,
});
const erro = (mensagem: string) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error: new Error(mensagem),
});

beforeEach(() => {
  vi.clearAllMocks();
  m.consulta.mockReturnValue(sucesso(painel()));
});
afterEach(cleanup);

const valorDo = (id: string) =>
  document.querySelector(`[data-numero="${id}"] [data-valor]`)?.textContent;

async function escolher(user: ReturnType<typeof userEvent.setup>, combo: string, opcao: string) {
  await user.click(screen.getByRole("combobox", { name: combo }));
  await user.click(await screen.findByRole("option", { name: opcao }));
}

describe("sem investimento", () => {
  it("diz o estado e mostra — (nunca 0) em custo por venda e ROAS", () => {
    render(<PainelDoFunilClient podeConectar />);
    const cartao = document.querySelector('[data-numero="investimento"]') as HTMLElement;
    expect(within(cartao).getByText("Não disponível")).toBeTruthy();
    expect(cartao.textContent).toContain("Nenhuma conta de anúncios conectada");
    expect(valorDo("custo_por_venda")).toBe("—");
    expect(valorDo("roas")).toBe("—");
    expect(valorDo("ganhos_de_anuncio")).toBe("—");
  });

  it("quem não pode conectar não é mandado para Configurações", () => {
    render(<PainelDoFunilClient podeConectar={false} />);
    const texto = document.querySelector('[data-numero="investimento"]')?.textContent ?? "";
    expect(texto).toContain("Peça a quem administra");
    expect(texto).not.toContain("Configurações › Meta Ads");
  });
});

describe("formulário depois de um Aplicar com erro", () => {
  it("mantém funis, campos e período da última resposta boa e mostra o erro", async () => {
    const user = userEvent.setup();
    // Resposta ESTÁVEL entre renders, como o cache do react-query entrega.
    const bom = sucesso(painel());
    const ruim = erro("A data inicial é depois da final.");
    m.consulta.mockImplementation((f: FiltrosDoPainel) => (f.de ? ruim : bom));
    const { container } = render(<PainelDoFunilClient podeConectar />);
    const [de] = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    await user.clear(de!);
    await user.type(de!, "2026-10-15");
    await user.click(screen.getByRole("button", { name: "Aplicar" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "A data inicial é depois da final.",
    );
    const [, ate] = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(ate!.value).toBe("2026-09-30");
    expect(screen.getByRole("combobox", { name: "Funil" }).textContent).toContain("Comercial");
    await escolher(user, "Recorte", "Campo do card");
    expect(screen.queryByText("Nenhum campo de lista neste funil.")).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Campo" }));
    expect(await screen.findByRole("option", { name: "Modalidade" })).toBeTruthy();
  });
});

describe("recorte por campo do card", () => {
  it("lista os campos do funil ESCOLHIDO no rascunho, não do carregado", async () => {
    const user = userEvent.setup();
    render(<PainelDoFunilClient podeConectar />);
    await escolher(user, "Funil", "Acompanhamento");
    await escolher(user, "Recorte", "Campo do card");
    await user.click(screen.getByRole("combobox", { name: "Campo" }));
    expect(await screen.findByRole("option", { name: "Convênio" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Modalidade" })).toBeNull();
  });

  it("Aplicar fica desligado até escolher o campo (ou o prefixo)", async () => {
    const user = userEvent.setup();
    render(<PainelDoFunilClient podeConectar />);
    const aplicar = screen.getByRole("button", { name: "Aplicar" });
    await escolher(user, "Recorte", "Campo do card");
    expect(aplicar).toHaveProperty("disabled", true);
    await escolher(user, "Campo", "Modalidade");
    await waitFor(() => expect(aplicar).toHaveProperty("disabled", false));

    await escolher(user, "Recorte", "Etiqueta com prefixo");
    expect(aplicar).toHaveProperty("disabled", true);
    await user.type(screen.getByPlaceholderText("criativo-"), "criativo-");
    expect(aplicar).toHaveProperty("disabled", false);
  });
});
