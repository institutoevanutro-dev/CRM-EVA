"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

/**
 * "REABRIR E RESPONDER" (I3): reabre JÁ com quem clicou como dona.
 *
 * `status: "claimed"` passa por `fn_conversation_assign` no PATCH
 * (`app/api/v1/conversations/_handler.ts`): grava o dono, o evento de
 * atribuição e a pausa do automático, e o `trg_service_reopened_routing` não
 * dispara (ele só olha `open`/`pending` sem dono). O "Reabrir" do cabeçalho
 * manda `status: "open"`, que tira o dono e devolve a conversa à fila — e a
 * fila pode entregá-la ao automático ou a uma colega enquanto a atendente
 * escreve. Para quem vai responder, é o caminho errado.
 *
 * SEM `expected_revision`, de propósito: a RPC de atribuição muda o status
 * para `claimed` ANTES de `fn_service_status` ler a revisão, e o gatilho
 * `trg_service_stamp_status` já sobe a revisão nesse primeiro passo. Mandar a
 * revisão que a tela leu daria 409 com o dono já gravado — a conversa reaberta
 * e a atendente vendo erro. O atalho `claimed` nunca teve lock otimista.
 *
 * O `onSettled` devolve a promessa da releitura: quem chama com `onSuccess`
 * só roda depois que a conversa voltou aberta, com o campo de texto montado.
 */
export function useReabrirEResponder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { conversation_id: string }) =>
      apiClient.patch<{ data: Conversation }>(`/api/v1/conversations/${args.conversation_id}`, {
        status: "claimed",
      }),
    onError: showApiError,
    onSettled: (_data, _error, args) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["conversations"] }),
        qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] }),
      ]),
  });
}
