/**
 * GET /api/v1/comentarios/publicacoes?canal=<channel_session_id> — as
 * publicações recentes de um perfil conectado, para o formulário de regra de
 * comentário oferecer o vídeo na tela em vez de pedir o id do post.
 *
 * Mesmo piso da criação de regra (`manager`). O canal vem da query, mas só vale
 * se for da organização da sessão (filtro explícito); a org nunca vem do
 * cliente. Nada é gravado: a lista é consultada na hora e as URLs de capa são
 * de CDN e expiram.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_SESSION_REF_COLUMNS, getAdapter, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({ canal: z.string().uuid() });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "instagram_comment_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = querySchema.safeParse({ canal: req.nextUrl.searchParams.get("canal") });
  if (!parsed.success) return fail("validation_failed", t("Escolha o perfil conectado."), 422, { requestId });

  const supabase = await createClient();
  const { data: sessao } = await supabase
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", parsed.data.canal)
    .eq("organization_id", authz.org.orgId)
    .is("archived_at", null)
    .maybeSingle();

  let sessionRef: string | null = null;
  const adapter = sessao ? getAdapter((sessao as ChannelSessionRef).provider) : null;
  try {
    if (sessao) sessionRef = resolveSessionRef(sessao as ChannelSessionRef);
  } catch {
    sessionRef = null;
  }
  if (!sessionRef || !adapter?.listarPublicacoes) {
    return fail("validation_failed", t("Perfil conectado não encontrado ou não lista publicações."), 422, { requestId });
  }

  const publicacoes = await adapter.listarPublicacoes({ organizationId: authz.org.orgId, sessionRef });
  if (publicacoes === null) {
    return fail("upstream_unavailable", t("Não deu para buscar os vídeos agora. Tente de novo ou cole o id do post."), 502, { requestId });
  }
  return ok({ publicacoes }, { requestId });
}
