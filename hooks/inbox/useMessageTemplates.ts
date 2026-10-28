"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
  /** Itens da Biblioteca de mídia que saem com o texto (migration 0383); ausente = só texto. */
  media_item_ids?: string[] | null;
  /**
   * A posição na lista, a que o arrastar da tela grava (migration 0394).
   * Opcional pelo mesmo motivo das mídias: fixture de teste vem sem a chave.
   */
  ordem?: number;
  /**
   * "Mostrar na barra do Inbox" (migration 0398). Ausente conta como ligado:
   * fixture sem a chave aparece na barra, como sempre. Só o `false` esconde.
   */
  mostrar_na_barra?: boolean | null;
}

/** A chave da lista: a tela, o Inbox e a mutação de ordem usam a MESMA. */
export const CHAVE_DOS_TEMPLATES = ["message-templates"] as const;

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: CHAVE_DOS_TEMPLATES,
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

/**
 * A REORDENAÇÃO (porte do original #3261): arrastar uma resposta rápida e
 * soltar em outro lugar. No fio vai o VIZINHO da esquerda (`depois_de`, `null`
 * = primeira), nunca o índice. A invalidação é da chave da listagem, que é a
 * que o Inbox lê (menu `/` e barra "Respostas rápidas"): a ordem nova chega lá
 * sem caminho paralelo.
 */
export function useMoverTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, depoisDe }: { id: string; depoisDe: string | null }) =>
      apiClient.put<{ data: MessageTemplate }>(`/api/v1/message-templates/${id}/ordem`, {
        depois_de: depoisDe,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_TEMPLATES }),
  });
}
