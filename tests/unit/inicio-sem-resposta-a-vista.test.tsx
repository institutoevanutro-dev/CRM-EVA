/**
 * D1.6: no gráfico "Conversas · últimos 30 dias", quem ficou sem resposta é a
 * faixa que pede ação. Ela vai para a BASE da pilha, em cor de erro com
 * hachura, e ganha número com porta para o Radar — a informação não depende só
 * da cor.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const barras = vi.hoisted(() => [] as { dataKey: string; fill: string }[]);

vi.mock("recharts", () => {
  const Passa = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Passa,
    BarChart: Passa,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Bar: (p: { dataKey: string; fill: string }) => {
      barras.push({ dataKey: p.dataKey, fill: p.fill });
      return null;
    },
  };
});

const falha = { ok: false };
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        resumo: falha,
        agenda: falha,
        funil: falha,
        origem: falha,
        conversas: {
          ok: true,
          primeiraRespostaMediaS: 90,
          dias: [
            { dia: "2026-11-01", ia_sozinha: 4, com_equipe: 2, sem_resposta: 3 },
            { dia: "2026-11-02", ia_sozinha: 1, com_equipe: 0, sem_resposta: 2 },
          ],
        },
      },
    })),
  },
}));

describe("Início — Sem resposta à vista", () => {
  it("mostra quantos ficaram sem resposta, com link para o Radar, e põe a faixa na base", async () => {
    const { PaineisDaClinica } = await import("@/app/app/inicio/_components/PaineisDaClinica");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PaineisDaClinica />
      </QueryClientProvider>,
    );

    const rotulo = await screen.findByText("ficaram sem resposta");
    const link = rotulo.closest("a");
    expect(link?.getAttribute("href")).toBe("/app/radar");
    expect(link?.textContent).toContain("5");
    expect(link?.className).toContain("text-error-fg");
    expect(screen.queryByText("a IA resolveu sozinha")).toBeNull();

    const ordem = barras.slice(-3);
    expect(ordem.map((b) => b.dataKey)).toEqual(["sem_resposta", "ia_sozinha", "com_equipe"]);
    expect(ordem[0]!.fill).toMatch(/^url\(#/);
    expect(ordem[1]!.fill).toBe("var(--color-accent-strong)");
    expect(ordem[2]!.fill).toBe("var(--grafico-equipe)");
  });
});
