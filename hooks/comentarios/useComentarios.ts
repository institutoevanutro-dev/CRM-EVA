"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ComentarioDaFila } from "@/components/inbox/comentarios/ListaDeComentarios";
import type { NovaRegraDeComentario } from "@/components/inbox/comentarios/FormularioDeRegra";

const CHAVE = ["instagram-comments"] as const;

/** A fila de comentários da org ativa — RLS já filtra, `enabled` espera a org resolver. */
export function useComentarios(orgId: string | null) {
  return useQuery({
    queryKey: [...CHAVE, orgId],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () => apiClient.get<{ data: ComentarioDaFila[] }>("/api/v1/comentarios").then((r) => r.data),
  });
}

export function usePublicarComentario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, texto }: { id: string; texto: string }) =>
      apiClient.post(`/api/v1/comentarios/${id}/publicar`, { texto }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: showApiError,
  });
}

export function useCriarRegraDeComentario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (regra: NovaRegraDeComentario) => apiClient.post("/api/v1/comentarios/regras", regra),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: showApiError,
  });
}
