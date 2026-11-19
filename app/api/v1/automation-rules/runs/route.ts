/**
 * GET /api/v1/automation-rules/runs?limit=50&cursor=… — histórico de execuções
 * da ORG inteira (cross-rule), desc. Usado pela aba Atividade (timeline global).
 *
 * Paginado por cursor (`created_at` + `id`): 50 execuções cobrem cerca de um dia
 * numa clínica, e a tela não tinha como ver o que veio antes ("Carregar mais").
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ID, INSTANTE, lerCursorJson } from "@/lib/api/filtro-postgrest";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT, MAX_LIMIT);
  const cursorRaw = req.nextUrl.searchParams.get("cursor");
  const cursor = cursorRaw ? lerCursorJson(cursorRaw, { created_at: INSTANTE, id: ID }) : null;
  if (cursorRaw && !cursor) return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });

  const supabase = await createClient();
  let q = supabase
    .from("automation_rule_runs")
    .select("*, automation_rules(name)")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (cursor) {
    q = q.or(
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await q;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const rows = (data ?? []) as { id: string; created_at: string }[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return ok(page, {
    requestId,
    meta: {
      has_more: hasMore,
      cursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id }), "utf8").toString("base64url")
          : null,
    },
  });
}
