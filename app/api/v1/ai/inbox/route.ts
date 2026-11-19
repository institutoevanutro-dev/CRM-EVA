/**
 * Épico Operação Visível (F1) — central de avisos do agente.
 * GET → agent_inbox_items da org (default: abertos), mais recente primeiro.
 * Itens de plataforma (organization_id null) são do operador do sistema, não
 * do tenant — nunca entram aqui.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolverDestinosDosAvisos } from "@/lib/ai/inbox-destino";
import { traduzir } from "@/lib/i18n/dicionario";
import { avisosAbertos } from "@/lib/inicio/meu-dia";
import { FUSO_PADRAO } from "@/lib/inicio/tipos";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "ack", "resolved", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit } = parsed.data;

  const admin = createAdminClient();
  let query = admin
    .from("agent_inbox_items")
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  const { data, error } = await query;
  if (error) {
    return fail("internal_error", t("Falha ao carregar os avisos."), 500, { requestId });
  }

  const { count: openCount } = await admin
    .from("agent_inbox_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", org.orgId)
    .eq("status", "open");

  const db = await createClient();
  const items = await resolverDestinosDosAvisos(db, org.orgId, org.role, data ?? []);

  // O sino conta os avisos DA PESSOA — o mesmo recorte do Início (decisão do
  // André, 18/11) —, e não os 144 da clínica. Falhou? `null`: o sino some em
  // vez de mostrar um número errado.
  let myOpenCount: number | null = null;
  if (status === "open") {
    try {
      const meus = await avisosAbertos(db, {
        orgId: org.orgId,
        userId: authz.user.id,
        agora: new Date(),
        fuso: FUSO_PADRAO,
        idioma: authz.user.idioma,
        papel: org.role,
      });
      if (meus.ok) myOpenCount = meus.total;
    } catch {
      myOpenCount = null;
    }
  }
  return ok({ items, open_count: openCount ?? 0, my_open_count: myOpenCount }, { requestId });
}
