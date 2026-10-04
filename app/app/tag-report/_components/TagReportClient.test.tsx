/**
 * A tela do relatório por etiqueta: com dados, vazia, com erro — e a espera
 * escrita como gente lê. O contrato da rota é provado em
 * `tests/unit/reports-por-etiqueta.test.ts`; aqui só o que a TELA faz com ele.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as HookDoRelatorio from "@/hooks/reports/useTagReport";
import { janelaDosUltimosDias, type RelatorioPorEtiqueta } from "@/hooks/reports/useTagReport";

import { TagReportClient, esperaLegivel } from "./TagReportClient";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

let estado: { data?: { data: RelatorioPorEtiqueta }; isLoading: boolean; isError: boolean };
vi.mock("@/hooks/reports/useTagReport", async (original) => ({
  ...(await original<typeof HookDoRelatorio>()),
  useTagReport: () => estado,
}));

function relatorio(parcial: Partial<RelatorioPorEtiqueta>): { data: RelatorioPorEtiqueta } {
  return {
    data: {
      janela: { de: "2026-09-05", ate: "2026-10-04", tz: "America/Sao_Paulo" },
      linhas: [],
      total_etiquetagens: 0,
      sem_dados: false,
      motivo: null,
      truncado: false,
      ...parcial,
    },
  };
}

beforeEach(() => {
  estado = { isLoading: false, isError: false };
});

describe("esperaLegivel", () => {
  it.each([
    [null, "—"],
    [0, "< 1 min"],
    [59, "< 1 min"],
    [60, "1 min"],
    [12 * 60, "12 min"],
    [3600, "1 h"],
    [2 * 3600 + 5 * 60, "2 h 5 min"],
    [86_400, "1 d"],
    [3 * 86_400 + 4 * 3600, "3 d 4 h"],
  ])("%s s → %s", (segundos, esperado) => {
    expect(esperaLegivel(segundos)).toBe(esperado);
  });
});

describe("janelaDosUltimosDias", () => {
  it("conta hoje e cabe no teto de 90 dias da rota", () => {
    // 02:00Z de 01/10 ainda é 30/09 em São Paulo.
    const agora = new Date("2026-10-01T02:00:00Z");
    expect(janelaDosUltimosDias(30, "America/Sao_Paulo", agora)).toEqual({
      de: "2026-09-01",
      ate: "2026-09-30",
    });
    expect(janelaDosUltimosDias(90, "UTC", agora)).toEqual({ de: "2026-07-04", ate: "2026-10-01" });
  });
});

describe("TagReportClient", () => {
  it("com dados: uma linha por etiqueta, na ordem da rota, com espera e fatia", () => {
    estado.data = relatorio({
      linhas: [
        { etiqueta: "orcamento", conversas: 8, abertas: 3, resolvidas: 5, espera_media_segundos: 750, fatia: 80 },
        { etiqueta: "reclamacao", conversas: 2, abertas: 2, resolvidas: 0, espera_media_segundos: null, fatia: 20 },
      ],
      total_etiquetagens: 10,
    });
    const html = renderToStaticMarkup(<TagReportClient />);
    expect(html).toContain('data-testid="tabela-por-etiqueta"');
    const ordem = [...html.matchAll(/data-etiqueta="([^"]+)"/g)].map((m) => m[1]);
    expect(ordem).toEqual(["orcamento", "reclamacao"]);
    expect(html).toContain("13 min");
    expect(html).toContain("80%");
    expect(html).toContain("—");
    expect(html).not.toContain("aviso-de-corte");
  });

  it("truncado: a tela diz que o número não é o período inteiro", () => {
    estado.data = relatorio({
      linhas: [{ etiqueta: "a", conversas: 1, abertas: 1, resolvidas: 0, espera_media_segundos: 60, fatia: 100 }],
      truncado: true,
    });
    expect(renderToStaticMarkup(<TagReportClient />)).toContain('data-testid="aviso-de-corte"');
  });

  it("vazio: diz o que fazer, e não desenha tabela de zeros", () => {
    estado.data = relatorio({ sem_dados: true, motivo: "nenhuma_conversa_com_etiqueta_no_periodo" });
    const html = renderToStaticMarkup(<TagReportClient />);
    expect(html).toContain("Nenhuma conversa com etiqueta no período");
    expect(html).toContain('href="/app/inbox"');
    expect(html).not.toContain("tabela-por-etiqueta");
  });

  it("erro: mensagem legível, sem tabela", () => {
    estado.isError = true;
    const html = renderToStaticMarkup(<TagReportClient />);
    expect(html).toContain("Erro ao carregar o relatório.");
    expect(html).not.toContain("tabela-por-etiqueta");
  });
});
