"use server";

/**
 * As preferências da organização para os avisos às plataformas de anúncio:
 *
 *  - "só quem veio de anúncio". Nasce ligada (`lib/conversoes/preferencias.ts`);
 *    desligar faz o paciente orgânico também sair para as plataformas ligadas.
 *  - quais etapas do funil querem dizer "sinal pago". Nasce vazia. Cada id tem
 *    de ser etapa da PRÓPRIA organização (conferido aqui, com o filtro de
 *    organização, porque o client é service-role); id de fora recusa tudo.
 *    A auditoria grava os ids, nunca o nome da etapa.
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
import { MAXIMO_DE_ETAPAS_DE_SINAL, settingsComPreferencias } from "@/lib/conversoes/preferencias";
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

const entradaSchema = z
  .object({
    somente_de_anuncio: z.boolean().optional(),
    etapas_de_sinal_pago: z.array(z.string().uuid()).max(MAXIMO_DE_ETAPAS_DE_SINAL).optional(),
  })
  .refine((v) => v.somente_de_anuncio !== undefined || v.etapas_de_sinal_pago !== undefined);

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
  const etapas = parsed.data.etapas_de_sinal_pago ? [...new Set(parsed.data.etapas_de_sinal_pago)] : undefined;
  if (etapas?.length) {
    const { data: daOrg, error: erroEtapas } = await admin
      .from("crm_stages")
      .select("id")
      .eq("organization_id", activeOrg.orgId)
      .in("id", etapas);
    if (erroEtapas) return { ok: false, error: "erro_ao_gravar" };
    if ((daOrg ?? []).length !== etapas.length) return { ok: false, error: "validation_failed" };
  }

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
        etapasDeSinalPago: etapas,
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
    metadata: {
      ...(parsed.data.somente_de_anuncio !== undefined ? { somente_de_anuncio: parsed.data.somente_de_anuncio } : {}),
      ...(etapas !== undefined ? { etapas_de_sinal_pago: etapas } : {}),
    },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
