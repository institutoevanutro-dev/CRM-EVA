/**
 * Grava o comentário do Instagram como recebido — só isso. Responder (regra ou
 * IA) é decisão de worker (Task 7); esta rota nunca chama a Graph API.
 * Idempotência pela reentrega da Meta: `(organization_id, external_id)` é
 * único (migration 0280), então 23505 no insert é desfecho normal, não erro.
 *
 * Erro do insert que NÃO é 23505 vira `falhou_infra`, não `ignorado`: não há
 * caminho determinístico que rejeite um insert válido aqui (o payload já foi
 * validado pelo parser) — um erro aqui é timeout/conexão do Postgres, e o
 * supabase-js resolve com `error` em vez de lançar. A rota trata `falhou_infra`
 * como faria com uma exceção (500, para a Meta reentregar); o índice único
 * torna a reentrega inócua. Perder o comentário para sempre é pior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComentarioDoInstagram } from "../webhook";

export type ResultadoDaIngestaoDoComentario =
  | { status: "gravado"; id: string }
  | { status: "ignorado"; motivo: string }
  | { status: "falhou_infra"; motivo: string };

export interface SessaoParaComentario {
  id: string;
  organizationId: string;
}

export async function ingerirComentario(
  admin: SupabaseClient,
  comentario: ComentarioDoInstagram,
  sessao: SessaoParaComentario,
): Promise<ResultadoDaIngestaoDoComentario> {
  if (comentario.eco) return { status: "ignorado", motivo: "eco" };

  const { data, error } = await admin.from("instagram_comments").insert({
    organization_id: sessao.organizationId,
    channel_session_id: sessao.id,
    external_id: comentario.externalId,
    media_id: comentario.mediaId,
    texto: comentario.texto,
    autor_igsid: comentario.autorIgsid,
    autor_handle: comentario.autorHandle,
    comentado_em: comentario.comentadoEm.toISOString(),
    situacao: "novo",
  }).select("id").maybeSingle();

  if (error) {
    if (error.code === "23505") return { status: "ignorado", motivo: "ja_recebido" };
    return { status: "falhou_infra", motivo: error.message };
  }
  const id = (data as { id: string } | null)?.id ?? "";
  return { status: "gravado", id };
}
