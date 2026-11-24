/**
 * POST /api/v1/agenda/clinicorp/copiar — "Copiar agora": a mesma cópia do cron
 * (`lib/agenda/clinicorp/copia.ts`), pedida pela tela. Gate = manager+; a
 * organização vem da sessão. Audita sempre: é um gestor pedindo, não uma rodada
 * de cron.
 */
import { randomUUID } from "node:crypto";

import { copiarDaClinicorp, MOTIVOS } from "@/lib/agenda/clinicorp/copia";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const org = authz.org.orgId;

  const r = await copiarDaClinicorp(createAdminClient(), org);
  if (!r.ok && r.motivo === "nao_configurada") {
    return fail("not_found", t("Salve a credencial da Clinicorp primeiro."), 404, { requestId });
  }
  void audit({
    action: "agenda.clinicorp_copiada",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "calendar_clinicorp_integration",
    resourceId: org,
    requestId,
    metadata: r.ok
      ? { origem: "tela", itens: r.itens, gravados: r.gravados, profissionais: r.profissionais }
      : { origem: "tela", falhou: r.motivo },
  });
  if (!r.ok) return fail("upstream_unavailable", t(MOTIVOS[r.motivo as keyof typeof MOTIVOS]), 502, { requestId });
  return ok({ itens: r.itens, gravados: r.gravados, profissionais: r.profissionais }, { requestId });
}
