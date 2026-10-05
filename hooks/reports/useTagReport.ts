"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/** O contrato de `GET /api/v1/reports/tags` (ver o cabeçalho da rota). */
export interface LinhaDeEtiqueta {
  etiqueta: string;
  conversas: number;
  abertas: number;
  resolvidas: number;
  /** `null` = nenhuma conversa da etiqueta tinha espera mensurável. */
  espera_media_segundos: number | null;
  /** 0–100, já arredondado pela rota. */
  fatia: number;
}

export interface RelatorioPorEtiqueta {
  janela: { de: string; ate: string; tz: string };
  linhas: LinhaDeEtiqueta[];
  total_etiquetagens: number;
  sem_dados: boolean;
  motivo: string | null;
  truncado: boolean;
}

/** Mesmo fuso que `useActivityReport` manda: o do navegador de quem lê. */
function fusoDoNavegador(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * "Últimos N dias" → `de`/`ate` no calendário do fuso, contando hoje. A rota
 * conta os dois extremos e recusa mais de 90, então a janela é `hoje − (N−1)`.
 */
export function janelaDosUltimosDias(dias: number, tz: string, agora = new Date()): {
  de: string;
  ate: string;
} {
  const ate = agora.toLocaleDateString("en-CA", { timeZone: tz });
  const [a, m, d] = ate.split("-").map(Number) as [number, number, number];
  const de = new Date(Date.UTC(a, m - 1, d - (dias - 1))).toISOString().slice(0, 10);
  return { de, ate };
}

export function useTagReport(dias: number) {
  return useQuery({
    queryKey: ["reports", "tags", dias],
    queryFn: async () => {
      const tz = fusoDoNavegador();
      const { de, ate } = janelaDosUltimosDias(dias, tz);
      return apiClient.get<{ data: RelatorioPorEtiqueta }>(
        `/api/v1/reports/tags?de=${de}&ate=${ate}&tz=${encodeURIComponent(tz)}`,
      );
    },
    staleTime: 30_000,
  });
}
