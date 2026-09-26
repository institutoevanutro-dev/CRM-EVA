/**
 * POST /api/v1/comentarios/regras — cria uma regra em `instagram_comment_rules`
 * (palavra-gatilho → resposta pública + Direct, por mídia — Task 8 da feature
 * "comentários no CRM"). Exige papel `manager`, mesmo piso da policy de
 * escrita `instagram_comment_rules_write` (migration 0280).
 *
 * A regra é POR MÍDIA e a tabela pede `channel_session_id not null`. Duas
 * formas de resolver o canal:
 *
 *  1. A mídia JÁ tem comentário: resolve pelo comentário MAIS RECENTE daquela
 *     mídia na mesma organização (Doutrina DIRC — Integrar, não duplicar um
 *     seletor). Ignora `channel_session_id` do corpo mesmo que venha.
 *  2. A mídia AINDA não tem nenhum comentário (CRÍTICO 2 da revisão final —
 *     é o fluxo que a spec vende: "Comente CARDAPIO neste vídeo" ANTES do
 *     primeiro comentário): usa o `channel_session_id` que o formulário
 *     manda, desde que seja um canal da MESMA organização que sabe responder
 *     comentário (capacidade, não identidade — invariante 1 da doutrina de
 *     restrição de canal). Sem os dois, a rota recusa — a regra não pode
 *     nascer sem um canal de verdade para publicar.
 *
 * Client de sessão preserva RLS; organização vem de `requireRole`, nunca do
 * body. `.eq("organization_id", ...)` explícito mesmo assim.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_SESSION_REF_COLUMNS, getAdapter, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  media_id: z.string().trim().min(1).max(200),
  palavra: z.string().trim().min(1).max(200),
  texto_do_direct: z.string().trim().min(1).max(1000),
  frase_publica: z.string().trim().min(1).max(2200),
  /** Só usado quando a mídia ainda não tem nenhum comentário — ver caminho 2 acima. */
  channel_session_id: z.string().uuid().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "instagram_comment_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const { data: comentarioDaMidia } = await supabase
    .from("instagram_comments")
    .select("channel_session_id")
    .eq("organization_id", org.orgId)
    .eq("media_id", parsed.data.media_id)
    .not("channel_session_id", "is", null)
    .order("comentado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  let channelSessionId = (comentarioDaMidia as { channel_session_id?: string | null } | null)
    ?.channel_session_id;

  if (!channelSessionId) {
    const escolhido = parsed.data.channel_session_id;
    if (!escolhido) {
      return fail(
        "validation_failed",
        t("Ainda não há comentário desta mídia — escolha o perfil conectado para criar a regra."),
        422,
        { requestId },
      );
    }

    const { data: sessao } = await supabase
      .from("channel_sessions")
      .select(CHANNEL_SESSION_REF_COLUMNS)
      .eq("id", escolhido)
      .eq("organization_id", org.orgId)
      .maybeSingle();

    let sabeResponderComentario = false;
    if (sessao) {
      try {
        resolveSessionRef(sessao as ChannelSessionRef);
        sabeResponderComentario = Boolean(getAdapter((sessao as ChannelSessionRef).provider).responderComentario);
      } catch {
        sabeResponderComentario = false;
      }
    }
    if (!sabeResponderComentario) {
      return fail("validation_failed", t("Perfil conectado não encontrado ou não publica comentário."), 422, {
        requestId,
      });
    }
    channelSessionId = escolhido;
  }

  const { data: regra, error } = await supabase
    .from("instagram_comment_rules")
    .insert({
      organization_id: org.orgId,
      channel_session_id: channelSessionId,
      media_id: parsed.data.media_id,
      palavra: parsed.data.palavra,
      texto_do_direct: parsed.data.texto_do_direct,
      frase_publica: parsed.data.frase_publica,
      criada_por: user.id,
    })
    .select("id, media_id, palavra, texto_do_direct, frase_publica, ativa, created_at")
    .single();

  if (error || !regra) {
    return fail("internal_error", t("Falha ao criar a regra."), 500, { requestId });
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "instagram_comment_rule.created",
    resourceType: "instagram_comment_rules",
    resourceId: (regra as { id: string }).id,
    requestId,
    metadata: { media_id: parsed.data.media_id },
  });

  return ok(regra, { status: 201, requestId });
}
