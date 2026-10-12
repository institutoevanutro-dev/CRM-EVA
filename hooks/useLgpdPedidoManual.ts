"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { MarcarEntregueInput, RegistrarPedidoInput } from "@/lib/lgpd/pedido-manual";
import { randomId } from "@/lib/random-id";

/** A equipe registra o pedido que o titular fez fora do sistema. */
export function useRegistrarPedidoLgpd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (corpo: RegistrarPedidoInput) =>
      apiClient.post<{ data: { id: string; status: "received"; due_at: string } }>(
        "/api/v1/lgpd/requests",
        corpo,
        { idempotencyKey: randomId() },
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["lgpd-requests"] }),
  });
}

/** Fecha o pedido em revisão pendente depois que o relatório foi entregue à mão. */
export function useMarcarPedidoEntregue(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (corpo: MarcarEntregueInput) =>
      apiClient.post<{ data: { request_id: string; status: "completed" } }>(
        `/api/v1/lgpd/requests/${id}/deliver`,
        corpo,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["lgpd-request", id] });
      void queryClient.invalidateQueries({ queryKey: ["lgpd-requests"] });
    },
  });
}
