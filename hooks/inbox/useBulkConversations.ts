"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/** As ações em lote da Inbox: o mesmo discriminante da rota. */
export type AcaoEmLote = "close" | "archive" | "mark-read" | "pause-ai" | "transfer" | "hide";

interface ResultadoDoItem {
  id: string;
  feito: boolean;
  codigo?: string;
  motivo?: string;
}

interface RelatorioDoLote {
  acao: AcaoEmLote;
  total: number;
  feitos: number;
  recusados: number;
  resultados: ResultadoDoItem[];
}

interface BulkArgs {
  ids: string[];
  action: AcaoEmLote;
  to_user_id?: string;
  reason?: string;
}

/**
 * UMA chamada para N conversas (`POST /api/v1/conversations/bulk`, porte do
 * upstream #2909). O toast conta os dois lados: feitos e recusados, com o
 * motivo de cada recusa, que a rota já manda traduzido.
 */
export function useBulkConversations() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: (args: BulkArgs) =>
      apiClient.post<{ data: RelatorioDoLote }>("/api/v1/conversations/bulk", {
        action: args.action,
        ids: args.ids,
        ...(args.to_user_id ? { to_user_id: args.to_user_id } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    onError: (err) => showApiError(err),
    onSuccess: (res, args) => {
      const r = res.data;
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
      qc.invalidateQueries({ queryKey: ["conversation"] });
      if (args.action === "hide") {
        // O contato oculto sai também do radar, do Início e da ficha.
        qc.invalidateQueries({ queryKey: ["leads-at-risk"] });
        qc.invalidateQueries({ queryKey: ["inicio"] });
        qc.invalidateQueries({ queryKey: ["contacts"] });
        qc.invalidateQueries({ queryKey: ["contact"] });
      }

      const recusados = r.resultados.filter((x) => !x.feito);
      const verbo =
        args.action === "close" ? t("fechadas") : args.action === "hide" ? t("ocultadas do Inbox") : t("atualizadas");
      if (recusados.length === 0) {
        toast.success(`${r.feitos} ${t("conversas")} ${verbo}.`);
        return;
      }
      toast.warning(`${r.feitos} ${verbo}, ${recusados.length} ${t("recusadas")}.`, {
        description: recusados.map((x) => x.motivo ?? x.codigo ?? t("Recusada.")).join(" · "),
      });
    },
  });
}
