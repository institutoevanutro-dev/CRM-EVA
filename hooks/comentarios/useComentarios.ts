"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import type { ComentarioDaFila } from "@/components/inbox/comentarios/ListaDeComentarios";
import type { NovaRegraDeComentario } from "@/components/inbox/comentarios/FormularioDeRegra";

const CHAVE = ["instagram-comments"] as const;

/**
 * O desfecho de `POST /:id/publicar` — inclui `gravado`, que HTTP 200 sozinho
 * não distingue (achado 1 da revisão): a chamada à Graph pode ter saído com
 * sucesso e o UPDATE do banco falhar depois. Quando isso acontece a rota
 * ainda devolve 200 (é sucesso PARCIAL, não erro — não repetir por
 * reentrega), e `gravado: false` é o único sinal de que algo ficou pra trás.
 */
export interface DesfechoDaPublicacao {
  id: string;
  situacao: string;
  resposta_publica_id: string | null;
  gravado: boolean;
}

/** A fila de comentários da org ativa — RLS já filtra, `enabled` espera a org resolver. */
export function useComentarios(orgId: string | null) {
  return useQuery({
    queryKey: [...CHAVE, orgId],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: () => apiClient.get<{ data: ComentarioDaFila[] }>("/api/v1/comentarios").then((r) => r.data),
  });
}

export function usePublicarComentario() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: ({ id, texto }: { id: string; texto: string }) =>
      apiClient.post<{ data: DesfechoDaPublicacao }>(`/api/v1/comentarios/${id}/publicar`, { texto }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: CHAVE });
      // `gravado === false`: a resposta JÁ FOI PUBLICADA no Instagram e o
      // banco não confirmou — o comentário volta pra fila como se ninguém
      // tivesse clicado. Sem este aviso, `onSuccess` some em silêncio e o
      // próximo clique manda uma SEGUNDA resposta pública de verdade.
      if (res.data.gravado === false) {
        toast.warning(
          t(
            "A resposta JÁ FOI publicada no Instagram, mas não deu para atualizar aqui. Não publique de novo — isso enviaria uma segunda resposta.",
          ),
        );
      }
    },
    onError: showApiError,
  });
}

export function useCriarRegraDeComentario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (regra: NovaRegraDeComentario) => apiClient.post("/api/v1/comentarios/regras", regra),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: showApiError,
  });
}

/** IMPORTANTE 5: descarta (`situacao='ignorado'`) — sem isto a fila só cresce. */
export function useDescartarComentario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.post(`/api/v1/comentarios/${id}/descartar`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
    onError: showApiError,
  });
}

/**
 * CRÍTICO 2: os perfis de Instagram conectados da organização — só para
 * oferecer no seletor do formulário de regra quando a mídia ainda não tem
 * comentário nenhum (a rota não tem de onde resolver o canal automaticamente
 * nesse caso). Reusa a mesma rota que a tela de Conexões já usa — nenhuma
 * rota nova só para listar.
 */
export function useCanaisDoInstagram() {
  return useQuery({
    queryKey: ["instagram-comments-canais"],
    queryFn: () =>
      apiClient
        .get<{ data: { contas: { id: string; username: string | null; status: string }[] } }>(
          "/api/v1/channels/instagram",
        )
        .then((r) => r.data.contas.filter((c) => c.status === "WORKING")),
  });
}
