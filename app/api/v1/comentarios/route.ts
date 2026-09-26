/**
 * GET /api/v1/comentarios — a fila de `instagram_comments` da org ativa
 * (Task 8 da feature "comentários no CRM"). Leitura é aberta a qualquer
 * membro do tenant (RLS `instagram_comments_select`, migration 0280) — não
 * pede papel além de estar autenticado na organização.
 *
 * Client de sessão preserva RLS; organização vem de `requireRole`, nunca do
 * body. `.eq("organization_id", ...)` explícito mesmo assim — doutrina do
 * repo, não redundância (CLAUDE.md).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, texto, media_id, autor_handle, comentado_em, situacao, sugestao_de_resposta, motivo_do_toque";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "instagram_comments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("instagram_comments")
    .select(COLUNAS)
    .eq("organization_id", org.orgId)
    .order("comentado_em", { ascending: false })
    .limit(200);

  if (error) {
    return fail("internal_error", t("Falha ao carregar os comentários."), 500, { requestId });
  }

  return ok(data ?? [], { requestId });
}
