"use server";

/**
 * A preferência da organização para os avisos de agendamento: "só quem veio de
 * anúncio". Nasce ligada (`lib/conversoes/preferencias.ts`); desligar faz o
 * paciente orgânico também sair para as plataformas ligadas.
 *
 * Mesmo gate da conexão (admin da organização, sem escrita de suporte, MFA
 * quando houver fator) e auditada com o valor novo — não é segredo.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { settingsComPreferencias } from "@/lib/conversoes/preferencias";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type UpdatePreferenciasDeConversaoResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "erro_ao_gravar";
    };

const entradaSchema = z.object({ somente_de_anuncio: z.boolean() });

export async function updatePreferenciasDeConversao(
  input: z.infer<typeof entradaSchema>,
): Promise<UpdatePreferenciasDeConversaoResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!escreveComoPlatformAdmin(authUser) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (erroLeitura || !data) return { ok: false, error: "erro_ao_gravar" };

  const { error } = await admin
    .from("organizations")
    .update({
      settings: settingsComPreferencias((data as { settings?: unknown }).settings, {
        somenteDeAnuncio: parsed.data.somente_de_anuncio,
      }),
    } as never)
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  const hdrs = await headers();
  await audit({
    action: "ad_conversion_settings.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organizations",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata: { somente_de_anuncio: parsed.data.somente_de_anuncio },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
