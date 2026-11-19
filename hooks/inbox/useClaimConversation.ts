"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ECO_DE_ASSUMIR, liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import type { Conversation } from "@/lib/types/messaging";

interface ClaimArgs {
  conversation_id: string;
  expected_assignee?: string | null;
}

export function useClaimConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ClaimArgs) => {
      // Assumir dá dono ao negócio do contato: o aviso disso é da própria ação.
      marcarEcoLocal(ECO_DE_ASSUMIR);
      return apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/claim`,
        { expected_assignee: args.expected_assignee ?? null },
      );
    },
    onSettled: () => liberarEcoLocal(ECO_DE_ASSUMIR),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
