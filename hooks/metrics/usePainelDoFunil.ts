"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { LinhaDaDimensao, ValorPorMoeda } from "@/lib/metrics/painel-do-funil";

/** O contrato de `GET /api/v1/metrics/funil` (ver o cabeçalho da rota). */
export interface PainelDoFunil {
  periodo: { de: string; ate: string; fuso: string };
  funil: { id: string; nome: string };
  numeros: {
    leads: number;
    interagiram: number | null;
    taxa_interacao: number | null;
    perdidos: number;
    aviso_interacao: "sem_etapa_de_interacao" | null;
    etapa_interacao: string | null;
    ganhos: number;
    receita: ValorPorMoeda[];
    sem_valor: number;
    sem_moeda: number;
    ganhos_de_anuncio: number | null;
    custo_por_venda_cents: number | null;
    roas: number | null;
    agendados: number;
    realizados: number;
    faltas: number;
    sem_baixa: number;
    cancelados: number;
    taxa_comparecimento: number | null;
  };
  por_etapa: { stage_id: string; nome: string; alcancaram: number }[];
  dimensao: {
    tipo: "campo_contato" | "campo_card" | "etiqueta" | "campanha";
    estado?: string;
    linhas: LinhaDaDimensao[];
  } | null;
  investimento:
    | { estado: "ok"; conta: string; moeda: string; cents: number }
    | { estado: "nao_conectado" | "sem_conta" }
    | { estado: "indisponivel"; motivo: string };
  opcoes: {
    funis: { id: string; nome: string; padrao: boolean }[];
    campos_contato: { key: string; label: string }[];
    campos_card: { key: string; label: string }[];
  };
  truncado: boolean;
}

export interface FiltrosDoPainel {
  de?: string;
  ate?: string;
  pipeline_id?: string;
  dimensao?: string;
  campo?: string;
  prefixo?: string;
}

/**
 * Cada carregamento gasta 3 chamadas na plataforma de anúncios: 5 min de
 * `staleTime`, sem recarregar ao focar a janela e sem `retry` do react-query.
 */
export function usePainelDoFunil(filtros: FiltrosDoPainel) {
  const qs = new URLSearchParams(
    Object.entries(filtros).filter((par): par is [string, string] => Boolean(par[1])),
  ).toString();
  return useQuery({
    queryKey: ["metrics", "funil", qs],
    queryFn: () => apiClient.get<{ data: PainelDoFunil }>(`/api/v1/metrics/funil?${qs}`),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
