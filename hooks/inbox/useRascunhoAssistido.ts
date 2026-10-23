"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { sugestaoParaMostrar } from "@/lib/agent-engine/agent/sugestao-de-resposta";

/** O rascunho assistido como ele chega de `/conversations/:id/draft-reply`. */
export interface RascunhoDeResposta {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
}

/**
 * A chave da consulta dos rascunhos da conversa: UMA, para os dois lugares que
 * precisam do mesmo dado (porte do original #3234, issue #3027 lá).
 *
 * O `Composer` decide com ela se monta o bloco ou o botão de ícone, e o
 * `ReplyReviewPanel` lê os rascunhos por ela. Duas chaves escritas à mão em dois
 * arquivos divergem na primeira mudança, e a divergência é silenciosa: a tela
 * mostraria o ícone E o bloco ao mesmo tempo (ou nenhum dos dois).
 */
export function chaveDosRascunhos(conversationId: string) {
  return ["reply-drafts", conversationId] as const;
}

/**
 * Os rascunhos assistidos de uma conversa, com o poll de 4s de sempre.
 *
 * Responde a ÚNICA pergunta que a faixa faz: "há sugestão para mostrar?". A
 * resposta é `sugestaoParaMostrar`, a mesma função que o painel já usava para
 * escolher o texto: `dismissed`, `stale`, `sent` e a conversa sem rascunho dão
 * `undefined`, e aqui isso quer dizer "não há bloco".
 *
 * `ativo` desliga a consulta em NOTA (lá não há sugestão de resposta) e no
 * compositor bloqueado: o `GET` exige papel `agent`, e quem só lê levaria 403 a
 * cada 4s.
 *
 * `sondar` é de UM leitor só (o `Composer`): cada observador da mesma chave tem
 * o próprio relógio de `refetchInterval`, e dois relógios davam dois GET a cada
 * 4s. O painel lê o mesmo cache sem relógio próprio.
 */
export function useRascunhoAssistido(conversationId: string, ativo = true, sondar = true) {
  const qc = useQueryClient();
  const chave = chaveDosRascunhos(conversationId);
  const query = useQuery({
    queryKey: chave,
    queryFn: () =>
      apiClient.get<{ data: { drafts: RascunhoDeResposta[] } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    enabled: ativo,
    refetchInterval: ativo && sondar ? 4000 : false,
    retry: false,
  });
  return {
    /** A sugestão que merece o bloco; `undefined` = não há bloco a montar. */
    sugestao: sugestaoParaMostrar(query.data?.data.drafts),
    /** Relê os rascunhos agora (quem gerou uma sugestão pelo ícone chama isto). */
    invalidar: () => qc.invalidateQueries({ queryKey: chave }),
  };
}
