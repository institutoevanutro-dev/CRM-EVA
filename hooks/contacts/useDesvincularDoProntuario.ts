"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

/** Desfaz o vínculo do contato com a ficha do Prontuário (manager+). */
export function useDesvincularDoProntuario(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.delete(`/api/v1/contacts/${id}/prontuario-link`),
    onError: showApiError,
    onSuccess: () => {
      toast.success(traduzir("Contato desvinculado do Prontuário.", idiomaAtual()));
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
