/**
 * D1.6, na forma do Início claro (spec 2026-11-11): em "Atendimento · últimos 30
 * dias", quem ficou sem resposta é a faixa que pede ação. Ela tem HACHURA na
 * barra e na legenda (a informação não depende só da cor) e número com porta
 * para o Radar. O gráfico por dia saiu: agora é UMA barra.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const falha = { ok: false };
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        periodo: { mes: "2026-11-01", mesAnterior: "2026-10-01" },
        resumo: falha,
        esperando: falha,
        agenda: falha,
        funil: falha,
        origem: falha,
        atendimento: {
          ok: true,
          equipe: 2,
          ia: 5,
          semResposta: 5,
          deCadaDez: { equipe: 2, ia: 4, semResposta: 4 },
          medianaPrimeiraRespostaS: 90,
        },
      },
    })),
  },
}));

describe("Início — Sem resposta à vista", () => {
  it("mostra quantos ficaram sem resposta, com link para o Radar e hachura — nunca só a cor", async () => {
    const { PaineisDaClinica } = await import("@/app/app/inicio/_components/PaineisDaClinica");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <PaineisDaClinica />
      </QueryClientProvider>,
    );

    const rotulo = await screen.findByText("Sem resposta");
    const link = rotulo.closest("a");
    expect(link?.getAttribute("href")).toBe("/app/radar");
    expect(link?.textContent).toContain("5");

    // A amostra da legenda e a faixa da barra usam a mesma hachura na cor de erro.
    const amostra = link?.querySelector("[aria-hidden]") as HTMLElement;
    expect(amostra.style.background).toContain("repeating-linear-gradient");
    expect(amostra.style.background).toContain("var(--grafico-sem-resposta)");

    // UMA barra, três faixas proporcionais às contagens, na ordem da frase.
    const faixas = [...container.querySelectorAll<HTMLElement>("div.rounded-full > span")];
    expect(faixas.map((f) => f.style.flexGrow)).toEqual(["2", "5", "5"]);
    expect(faixas[0]!.style.background).toBe("var(--grafico-equipe)");
    expect(faixas[1]!.style.background).toBe("var(--color-accent-strong)");
    expect(faixas[2]!.style.background).toContain("repeating-linear-gradient");
  });
});
