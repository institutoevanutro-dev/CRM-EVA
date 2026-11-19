"use client";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

const DEBOUNCE_MS = 1500;

/**
 * Marca a conversa como lida após permanecer em foco (EPIC-03 S-03.10).
 * Só chama a API quando unread > 0 para evitar writes desnecessários.
 *
 * SÓ CONTA COM A ABA À VISTA (item 31 da auditoria de 17/11). A conversa aberta
 * virava "lida" em 1,5 s mesmo com a aba escondida — o inbox aberto numa aba de
 * fundo comia o sinal de mensagem nova da recepção. Com a aba escondida o
 * relógio espera ela voltar. Quem não pode responder (visualizador) não marca:
 * a rota recusa, e a tentativa só gerava erro.
 *
 * SÓ O RESPONSÁVEL MARCA AO ABRIR (decisão do André em 18/11). O gestor que abre
 * para conferir não apaga o sinal da recepção. Sem responsável, quem abrir
 * marca. "Marcar como lida" em lote continua valendo para qualquer um: é gesto
 * explícito, não efeito de abrir.
 */
export function deveMarcarAoAbrir(responsavelId: string | null | undefined, eu: string): boolean {
  return !responsavelId || responsavelId === eu;
}

export function useMarkAsRead(
  conversationId: string | null,
  unread: number,
  responsavelId: string | null | undefined,
) {
  const { user } = useAuth();
  const podeMarcar = usePermission("inbox.reply");
  const readonly =
    user.support?.access_mode === "support_readonly" || !podeMarcar || !deveMarcarAoAbrir(responsavelId, user.id);
  const qc = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { mutate } = useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ data: unknown }>(`/api/v1/conversations/${id}/mark-read`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", id] });
    },
  });

  useEffect(() => {
    if (readonly || !conversationId || unread <= 0) return;

    const parar = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const armar = () => {
      parar();
      if (document.visibilityState !== "visible") return;
      timerRef.current = setTimeout(() => mutate(conversationId), DEBOUNCE_MS);
    };

    armar();
    document.addEventListener("visibilitychange", armar);
    return () => {
      document.removeEventListener("visibilitychange", armar);
      parar();
    };
  }, [conversationId, unread, mutate, readonly]);
}
