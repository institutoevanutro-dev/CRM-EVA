"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";

/**
 * O que a bolha muda numa mensagem que já existe: o reenvio da que falhou
 * (portado do DeskcommCRM, PR #3192) e editar/apagar para todos a que o
 * atendente enviou (DeskcommCRM #1626).
 */
export function useAlterarMensagem(conversationId: string | null) {
  const qc = useQueryClient();
  const t = useT();
  // Reenvio da mensagem que falhou, na mesma linha. Sem toast no sucesso: a
  // própria bolha muda (sai de "Falhou"). A recarga é explícita porque a rede de
  // segurança do fio só percebe mensagem nova, não troca de status — e vale
  // também na recusa: a bolha decide com o relógio do aparelho e a rota com o do
  // servidor, e depois de um "não" a bolha tem de mostrar o estado real.
  const reenviar = useMutation({
    mutationFn: ({ id, confirmado }: { id: string; confirmado: boolean }) =>
      apiClient.post<{
        data: {
          status: string;
          error_code: string | null;
          error_message: string | null;
          metadata?: Record<string, unknown> | null;
        };
      }>(
        `/api/v1/messages/${id}/retry`,
        confirmado ? { confirmado: true } : {},
      ),
    // O canal recusou de novo: a rota responde 200 (`ok(message)`, o corpo vem
    // em `{ data }`) com a linha em `failed`, e sem este aviso o toque parece
    // não ter feito nada (WhatsApp fora do ar).
    onSuccess: (res) => {
      const msg = res?.data;
      // Número sem conexão: a linha volta para `queued` com o motivo, e mensagem
      // de pessoa não sai sozinha depois (o vigia do fork só reenvia a da IA).
      if (msg?.status === "queued" && msg.metadata?.queued_reason) {
        toast.error(t("A mensagem não saiu de novo."), { description: t("Não enviada: sem conexão") });
        return;
      }
      if (msg?.status !== "failed") return;
      toast.error(t("A mensagem não saiu de novo."), { description: motivoDaFalhaDaMensagem(msg, t) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    // "Confirme antes" não é erro para a pessoa: a bolha abre a confirmação.
    onError: (err) => {
      if (err instanceof ApiError && err.code === "confirmacao_necessaria") return;
      showApiError(err);
    },
  });
  // Editar e apagar: a bolha muda pela recarga, e o erro sobe para a bolha
  // manter o editor (ou a confirmação) aberto para nova tentativa.
  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ["messages", conversationId] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  };
  const editar = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      apiClient.patch(`/api/v1/messages/${id}`, { text }),
    onSuccess: () => toast.success(t("Mensagem editada")),
    onSettled: recarregar,
    onError: showApiError,
  });
  const apagar = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/v1/messages/${id}`),
    onSuccess: () => toast.success(t("Mensagem apagada para todos")),
    onSettled: recarregar,
    onError: showApiError,
  });
  return { reenviar, editar, apagar };
}
