"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Ocultar um contato do Inbox, ou trazê-lo de volta (migration 0372).
 *
 * Ocultar chega pela CONVERSA (o cabeçalho só a conhece) ou pelo CONTATO (a
 * ficha); trazer de volta é sempre pelo contato, e é de gerente. A marca muda o
 * Inbox inteiro — lista, contagens, radar, Início —, então tudo isso é relido.
 */
export type PedidoDeOcultacao =
  | { ocultar: true; conversationId: string }
  | { ocultar: boolean; contactId: string };

export function useOcultarDoInbox() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: (p: PedidoDeOcultacao) =>
      "conversationId" in p
        ? apiClient.post<{ data: unknown }>(`/api/v1/conversations/${p.conversationId}/ocultar`, {})
        : p.ocultar
          ? apiClient.post<{ data: unknown }>(`/api/v1/contacts/${p.contactId}/ocultar`, {})
          : apiClient.delete<{ data: unknown }>(`/api/v1/contacts/${p.contactId}/ocultar`),
    onError: showApiError,
    onSuccess: (_r, p) => {
      for (const chave of ["conversations", "conversation-counts", "conversation", "contact", "contacts", "leads-at-risk", "inicio"]) {
        void qc.invalidateQueries({ queryKey: [chave] });
      }
      toast.success(p.ocultar ? t("Contato ocultado do Inbox") : t("O contato voltou ao Inbox"));
    },
  });
}
