/**
 * NEM TODO NÚMERO É PROBLEMA.
 *
 * O total da primeira tela ganhou cor de atenção, e a tentação é pintar todo
 * total maior que zero. Isso quebra a tela para quem tem um dia BOM: "7" em
 * Minha agenda de hoje são sete consultas marcadas, e âmbar ali diz à recepção
 * que algo deu errado quando nada deu.
 *
 * A regra vigiada aqui é a distinção, não a cor: totais que contam coisas
 * ESPERANDO alguém (avisos, pacientes sem resposta, configuração pendente)
 * recebem `text-warning`; totais que contam o trabalho do dia, não.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { Bloco } from "@/lib/inicio/tipos";

const respostas = vi.hoisted(() => ({ inicio: null as unknown, health: null as unknown }));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (rota: string) => {
      if (rota.includes("health")) return { data: respostas.health };
      return { data: respostas.inicio };
    }),
  },
}));

function bloco(total: number): Bloco {
  return {
    ok: true,
    total,
    itens: Array.from({ length: Math.min(total, 2) }, (_, i) => ({
      id: `i${i}`,
      titulo: `Item ${i}`,
      detalhe: null,
      href: "/app/inbox",
    })),
  } as Bloco;
}

async function montar() {
  const { PainelInicio } = await import("@/app/app/inicio/_components/PainelInicio");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PainelInicio />
    </QueryClientProvider>,
  );
  await screen.findByText("Meu dia");
}

/** O `<p>` do total é o irmão que vem logo depois do título do cartão. */
function totalDoCartao(titulo: string): HTMLElement {
  const h = screen.getByText(titulo);
  const cartao = h.closest("section");
  if (!cartao) throw new Error(`cartão «${titulo}» não encontrado`);
  const p = cartao.querySelector("p.text-3xl");
  if (!p) throw new Error(`total do cartão «${titulo}» não encontrado`);
  return p as HTMLElement;
}

describe("painel Início — só pendência ganha cor", () => {
  beforeEach(() => {
    respostas.inicio = {
      meuDia: {
        avisos: bloco(7),
        esperando: bloco(3),
        agenda: bloco(7),
        tarefas: bloco(4),
      },
      gestao: null,
    };
    respostas.health = { status: "healthy" };
  });

  it("o total de avisos abertos ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Avisos da Central").className).toContain("text-warning");
  });

  it("o total de pacientes esperando resposta ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Pacientes esperando resposta").className).toContain("text-warning");
  });

  /**
   * O CASO QUE JUSTIFICA O CAMPO. Mesmo total (7) dos avisos, e aqui ele é uma
   * boa notícia: a agenda do dia está cheia.
   */
  it("o total da agenda de hoje NÃO ganha cor de atenção — dia cheio não é problema", async () => {
    await montar();
    expect(totalDoCartao("Minha agenda de hoje").className).not.toContain("text-warning");
  });

  it("o total de tarefas NÃO ganha cor de atenção", async () => {
    await montar();
    expect(totalDoCartao("Minhas tarefas").className).not.toContain("text-warning");
  });

  it("zero continua verde e sem número", async () => {
    respostas.inicio = {
      meuDia: { avisos: bloco(0), esperando: bloco(0), agenda: bloco(0), tarefas: bloco(0) },
      gestao: null,
    };
    await montar();
    expect(screen.getAllByText("Tudo em dia ✓").length).toBe(4);
  });
});
