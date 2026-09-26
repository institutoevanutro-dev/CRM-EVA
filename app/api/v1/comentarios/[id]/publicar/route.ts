/**
 * POST /api/v1/comentarios/:id/publicar — publica no Instagram a sugestão da
 * IA para um comentário `esperando_voce`, editada ou não (Task 8 da feature
 * "comentários no CRM"). Sempre resposta PÚBLICA (`responderComentario` do
 * adapter) — a privada, quando existe, já foi decidida e enviada (ou não)
 * pela regra/worker antes de o comentário cair aqui (Tasks 5-7, `lib/comentarios/acao.ts`).
 *
 * Exige papel `agent` — mesmo piso da policy de escrita `instagram_comments_write`
 * (migration 0280). Client de sessão preserva RLS; organização vem de
 * `requireRole`, nunca do body. `.eq("organization_id", ...)` explícito em
 * toda query mesmo assim — doutrina do repo, não redundância (CLAUDE.md).
 *
 * Nenhum nome de provider aqui: a sessão do canal é resolvida pelo
 * `channel_session_id` que a LINHA já carrega, e `getAdapter`/`resolveSessionRef`
 * (lib/channels) escolhem o transporte pela coluna `provider`, nunca por um
 * `if` escrito nesta rota (docs/doctrine/restricao-de-canal.md, invariante 1).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { motivoDaRecusaPorEspecialidade } from "@/lib/comentarios/especialidade";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  texto: z.string().trim().min(1).max(2200),
});

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "instagram_comments" });
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

  // IMPORTANTE 3 (revisão final): a mesma trava de RQE que o worker aplica
  // antes de a IA publicar sozinha — o texto recusado é gravado em
  // `sugestao_de_resposta`, a tela pré-preenche o rascunho com ELE MESMO, e
  // sem esta conferência o clique em Publicar mandava pro Instagram sem
  // reconferir nada (um clique publicava "nutrólogo" no nome de um médico
  // sem RQE). Roda ANTES de qualquer leitura de banco — recusa é barata.
  const motivoDaRecusa = motivoDaRecusaPorEspecialidade(parsed.data.texto);
  if (motivoDaRecusa) {
    return fail("validation_failed", t(motivoDaRecusa), 422, { requestId });
  }

  const supabase = await createClient();

  const { data: comentario, error: erroLeitura } = await supabase
    .from("instagram_comments")
    .select("id, situacao, external_id, channel_session_id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (erroLeitura) {
    return fail("internal_error", t("Falha ao carregar o comentário."), 500, { requestId });
  }
  if (!comentario) {
    return fail("not_found", t("Comentário não encontrado."), 404, { requestId });
  }
  const linha = comentario as {
    id: string;
    situacao: string;
    external_id: string;
    channel_session_id: string | null;
  };
  if (linha.situacao !== "esperando_voce") {
    return fail(
      "validation_failed",
      t("Este comentário não está mais esperando publicação."),
      409,
      { requestId },
    );
  }
  if (!linha.channel_session_id) {
    return fail(
      "validation_failed",
      t("Este comentário perdeu o vínculo com o canal — não há como publicar."),
      422,
      { requestId },
    );
  }

  const { data: sessao, error: erroSessao } = await supabase
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", linha.channel_session_id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroSessao || !sessao) {
    return fail("validation_failed", t("Canal não encontrado."), 422, { requestId });
  }

  let sessionRef: string;
  try {
    sessionRef = resolveSessionRef(sessao as ChannelSessionRef);
  } catch {
    return fail("internal_error", t("Canal com dados incompletos."), 500, { requestId });
  }
  const provider = (sessao as ChannelSessionRef).provider;
  const adapter = getAdapter(provider);
  if (!adapter.responderComentario) {
    return fail("validation_failed", t("Este canal não publica resposta pública."), 422, {
      requestId,
    });
  }

  let replyId: string | null = null;
  try {
    const resultado = await adapter.responderComentario({
      organizationId: org.orgId,
      sessionRef,
      commentId: linha.external_id,
      texto: parsed.data.texto,
    });
    replyId = resultado.replyId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : adapter.codes.unknownError;
    return fail(adapter.codes.sendFailed, msg, 502, { requestId });
  }

  const { data: atualizado, error: erroEscrita } = await supabase
    .from("instagram_comments")
    .update({
      situacao: "respondido_manualmente",
      resposta_publica_id: replyId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, situacao, resposta_publica_id")
    .maybeSingle();

  if (erroEscrita || !atualizado) {
    // A publicação JÁ SAIU no Instagram — não repetir por reentrega. O
    // desfecho fica sem gravar; a fila mostraria o comentário de novo, e um
    // segundo clique mandaria um segundo comentário público. Loga (é o ÚNICO
    // vestígio de que a publicação saiu — sem isto a falha é invisível dos
    // dois lados, banco e tela) e devolve sucesso parcial explícito em vez de
    // fingir erro que convidaria a repetir.
    logger.error("[comentarios] publicação saiu no Instagram mas o desfecho não foi gravado — não repetir", {
      comentarioId: id,
      organizationId: org.orgId,
      resposta_publica_id: replyId,
      erro: erroEscrita?.message,
    });
    return ok(
      { id, situacao: linha.situacao, resposta_publica_id: replyId, gravado: false },
      { requestId },
    );
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "comment.replied_manually",
    resourceType: "instagram_comment",
    resourceId: id,
    requestId,
    // IMPORTANTE 6 (revisão final): a spec (§9) promete medir quanto o
    // classificador erra a partir do toque do dono — sem o TEXTO que ele
    // publicou (editado ou não) no metadata, a auditoria só prova QUE alguém
    // publicou, não O QUE foi publicado, e a medição não existe.
    metadata: { resposta_publica_id: replyId, texto: parsed.data.texto },
  });

  return ok({ ...atualizado, gravado: true }, { requestId });
}
