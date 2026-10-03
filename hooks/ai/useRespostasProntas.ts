"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface PerguntaDaResposta {
  id: string;
  texto: string;
  reconhecida: boolean;
}
export interface RespostaProntaItem {
  id: string;
  titulo: string;
  resposta: string;
  ativo: boolean;
  revisado_em: string;
  perguntas: PerguntaDaResposta[];
}
export interface ConfigRespostasProntas {
  ligado: boolean;
  limite_similaridade: number;
}
export interface EstadoRespostasProntas {
  config: ConfigRespostasProntas;
  itens: RespostaProntaItem[];
}

const BASE = "/api/v1/ai/respostas-prontas";
const KEY = ["respostas-prontas"];

export function useRespostasProntas() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => apiClient.get<{ data: EstadoRespostasProntas }>(BASE).then((r) => r.data),
  });
}

export function useSalvarRespostaPronta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id?: string; titulo: string; resposta: string; perguntas: string[] }) => {
      const corpo = { titulo: input.titulo, resposta: input.resposta, perguntas: input.perguntas };
      return input.id
        ? apiClient.patch<{ data: { id: string; sem_reconhecimento: number } }>(`${BASE}/${input.id}`, corpo)
        : apiClient.post<{ data: { id: string; sem_reconhecimento: number } }>(BASE, corpo);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useAlterarRespostaPronta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; ativo?: boolean; revisado?: true }) => {
      const { id, ...corpo } = input;
      return apiClient.patch<{ data: { id: string } }>(`${BASE}/${id}`, corpo);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSalvarConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ConfigRespostasProntas) =>
      apiClient.put<{ data: ConfigRespostasProntas }>(`${BASE}/config`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCalcularReconhecimento() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<{ data: { calculadas: number; faltando: number } }>(`${BASE}/embeddings`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface MetricasRespostasProntas {
  dias: number;
  resolvidas_por_resposta_pronta: number;
  respondidas_pela_ia: number;
  custo_medio_turno_cents: number | null;
  custo_evitado_estimado_cents: number | null;
  custo_incompleto: boolean;
}

export function useMetricasRespostasProntas(dias: 7 | 30 | 90) {
  return useQuery({
    queryKey: [...KEY, "metricas", dias],
    queryFn: () =>
      apiClient.get<{ data: MetricasRespostasProntas }>(`${BASE}/metricas?dias=${dias}`).then((r) => r.data),
  });
}
