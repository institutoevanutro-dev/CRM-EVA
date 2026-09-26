/**
 * POST /api/v1/comentarios/regras — cria uma regra em `instagram_comment_rules`
 * (palavra-gatilho → resposta pública + Direct, por mídia — Task 8 da feature
 * "comentários no CRM"). Exige papel `manager`, mesmo piso da policy de
 * escrita `instagram_comment_rules_write` (migration 0279).
 *
 * A regra é POR MÍDIA e a tabela pede `channel_session_id not null`; o
 * formulário não pede canal (Doutrina DIRC — Integrar, não duplicar um
 * seletor): esta rota resolve o canal pelo comentário MAIS RECENTE daquela
 * mídia na mesma organização. Sem nenhum comentário ainda, a rota recusa — a
 * regra não pode nascer sem um canal de verdade para publicar.
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
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  media_id: z.string().trim().min(1).max(200),
  palavra: z.string().trim().min(1).max(200),
  texto_do_direct: z.string().trim().min(1).max(1000),
  frase_publica: z.string().trim().min(1).max(2200),
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

  const channelSessionId = (comentarioDaMidia as { channel_session_id?: string | null } | null)
    ?.channel_session_id;
  if (!channelSessionId) {
    return fail(
      "validation_failed",
      t("Ainda não há comentário desta mídia — crie a regra depois que o primeiro comentário chegar."),
      422,
      { requestId },
    );
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
