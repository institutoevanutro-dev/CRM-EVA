/**
 * POST /api/v1/bonus/ligacoes: registra a ligação de um item da fila de HOJE
 * de quem pede. O registro mora no item (fonte do bônus); quando o contato tem
 * negócio, a ficha ganha `call_logged` na timeline, sem o resumo (o resumo é
 * dado do titular e fica no item, que a anonimização alcança).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerPrograma } from "@/lib/bonus/fatos";
import { RESULTADOS_DE_LIGACAO } from "@/lib/bonus/tipos";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpo = z.object({
  item_id: z.string().uuid(),
  resultado: z.enum(RESULTADOS_DE_LIGACAO),
  resumo: z.string().trim().min(3).max(500),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_fila_itens" });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);
  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Escreva o resultado e um resumo curto."), 422, { requestId });

  const admin = createAdminClient();
  const org = authz.org.orgId;
  const lido = await lerPrograma(admin, org);
  if (lido.status !== "ok") return fail("not_found", t("O programa de bônus não está ligado."), 404, { requestId });

  const { data: item } = await admin
    .from("bonus_fila_itens")
    .select("id, dia, tipo, user_id, contact_id")
    .eq("id", parsed.data.item_id)
    .eq("organization_id", org)
    .maybeSingle();
  const linha = item as { id: string; dia: string; tipo: string; user_id: string; contact_id: string } | null;
  if (!linha || linha.user_id !== authz.user.id) return fail("not_found", t("Item da fila não encontrado."), 404, { requestId });
  if (linha.tipo !== "ligacao") return fail("validation_failed", t("Este item não é uma ligação."), 422, { requestId });
  if (linha.dia !== diaLocalISO(new Date(), lido.programa.fuso)) {
    return fail("validation_failed", t("Só dá para registrar a ligação no dia da fila."), 422, { requestId });
  }

  const { error } = await admin
    .from("bonus_fila_itens")
    .update({
      ligacao_resultado: parsed.data.resultado,
      ligacao_resumo: parsed.data.resumo,
      ligacao_registrada_em: new Date().toISOString(),
    })
    .eq("id", linha.id)
    .eq("organization_id", org)
    .eq("user_id", authz.user.id);
  if (error) return fail("internal_error", t("Erro ao registrar a ligação."), 500, { requestId });

  await audit({
    organizationId: org,
    actorUserId: authz.user.id,
    action: "bonus.ligacao_registrada",
    resourceType: "bonus_fila_itens",
    resourceId: linha.id,
    metadata: { resultado: parsed.data.resultado },
    requestId,
  });

  const { data: lead } = await admin
    .from("crm_leads")
    .select("id")
    .eq("organization_id", org)
    .eq("contact_id", linha.contact_id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lead) {
    const r = await emitLeadActivity(admin, {
      organizationId: org,
      leadId: (lead as { id: string }).id,
      contactId: linha.contact_id,
      type: "call_logged",
      sourceModule: "bonus",
      sourceId: linha.id,
      actor: { type: "user", id: authz.user.id },
      // Canônico em português: quem traduz é a leitura da timeline.
      reason: parsed.data.resultado === "atendeu" ? "Ligação registrada: atendeu" : "Ligação registrada: não atendeu",
      payload: { resultado: parsed.data.resultado },
    });
    if (!r.ok) logger.warn("[bonus.ligacoes] atividade não gravada", { organization_id: org, error: r.error });
  }
  return ok({ id: linha.id, resultado: parsed.data.resultado }, { requestId });
}
