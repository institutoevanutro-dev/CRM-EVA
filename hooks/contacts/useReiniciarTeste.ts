"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

/** Reinicia o teste do contato (número da lista de teste do canal). */
export function useReiniciarTeste(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: Record<string, number> }>(`/api/v1/contacts/${id}/reiniciar-teste`, {}),
    onError: showApiError,
    onSuccess: () => {
      toast.success(traduzir("Teste reiniciado. A próxima mensagem começa do zero.", idiomaAtual()));
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
