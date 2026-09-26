/**
 * POST /api/v1/comentarios/:id/descartar — marca um comentário `esperando_voce`
 * como `ignorado` (IMPORTANTE 5 da revisão final: `ignorado` está no CHECK da
 * migration 0279 e no vocabulário TypeScript, e nada no repositório o escrevia
 * — sem descartar, a fila só cresce, e "a aba fecha o dia vazia" é o critério
 * de sucesso da spec, §9).
 *
 * Mesmo piso de papel e mesma conferência de organização que
 * `POST /:id/publicar` — `agent+` (`instagram_comments_write`, migration
 * 0279); client de sessão preserva RLS, `.eq("organization_id", ...)`
 * explícito mesmo assim.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "instagram_comments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const supabase = await createClient();

  const { data: comentario, error: erroLeitura } = await supabase
    .from("instagram_comments")
    .select("id, situacao")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (erroLeitura) {
    return fail("internal_error", t("Falha ao carregar o comentário."), 500, { requestId });
  }
  if (!comentario) {
    return fail("not_found", t("Comentário não encontrado."), 404, { requestId });
  }
  const linha = comentario as { id: string; situacao: string };
  if (linha.situacao !== "esperando_voce") {
    return fail(
      "validation_failed",
      t("Este comentário não está mais esperando publicação."),
      409,
      { requestId },
    );
  }

  const { data: atualizado, error: erroEscrita } = await supabase
    .from("instagram_comments")
    .update({ situacao: "ignorado", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, situacao")
    .maybeSingle();

  if (erroEscrita || !atualizado) {
    return fail("internal_error", t("Falha ao descartar o comentário."), 500, { requestId });
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "comment.discarded",
    resourceType: "instagram_comment",
    resourceId: id,
    requestId,
    metadata: {},
  });

  return ok(atualizado, { requestId });
}
