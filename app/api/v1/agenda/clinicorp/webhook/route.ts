/**
 * POST /api/v1/agenda/clinicorp/webhook — gera o endereço do webhook da Clinicorp
 * (migration 0434). Gate = manager+, organização da sessão.
 *
 * O token (32 bytes aleatórios, 64 hex) volta UMA vez, dentro do caminho, e só o
 * sha256 dele é gravado. Gerar de novo troca o endereço: o anterior para de
 * funcionar na hora. A clínica sem a API da Clinicorp ganha aqui a linha da
 * integração, sem credencial.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const token = randomBytes(32).toString("hex");
  const linha = { webhook_token_hash: createHash("sha256").update(token).digest("hex"), updated_at: new Date().toISOString() };

  const { data: atual, error: erroAtual } = await admin
    .from("calendar_clinicorp_integrations")
    .select("webhook_token_hash")
    .eq("organization_id", org)
    .maybeSingle();
  if (erroAtual) return fail("internal_error", erroAtual.message, 500, { requestId });
  const { error } = atual
    ? await admin.from("calendar_clinicorp_integrations").update(linha).eq("organization_id", org)
    : await admin.from("calendar_clinicorp_integrations").insert({ organization_id: org, ...linha });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "agenda.clinicorp_webhook_gerado",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "calendar_clinicorp_integration",
    resourceId: org,
    requestId,
    // Que mudou, nunca o token nem o hash.
    metadata: { trocou_endereco: Boolean(atual?.webhook_token_hash) },
  });
  const res = ok({ caminho: `/api/v1/webhooks/clinicorp/${token}` }, { requestId });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
