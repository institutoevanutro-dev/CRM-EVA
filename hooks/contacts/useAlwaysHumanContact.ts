"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * Liga ou desliga a marca "sempre atendimento humano" (`contacts.ai_opt_out`).
 * Invalida as mesmas chaves de `useUnblockContact`: o Inbox lê o contato por
 * `conversation.contacts`, e a trava de robô da conversa muda junto.
 */
export function useAlwaysHumanContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (marcar: boolean) =>
      marcar
        ? apiClient.post<{ data: unknown }>(`/api/v1/contacts/${id}/always-human`, {})
        : apiClient.delete<{ data: unknown }>(`/api/v1/contacts/${id}/always-human`),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
