"use server";

/**
 * LIGAR E DESLIGAR A EXTRAÇÃO SILENCIOSA DE CADASTRO (migration 0407).
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualizar o produto): as
 * conversas atendidas pela equipe seguem como sempre — ninguém lê o CPF, o
 * e-mail, o nascimento ou o endereço que o cliente manda. LIGADA: esses dados
 * entram na ficha quando o campo está VAZIO, e valor diferente do gravado vira
 * proposta com aviso na Central (`lib/contacts/extracao-silenciosa.ts`).
 *
 * Mesmo desenho de `definirTelefoneDeFichaVazia`: service role com
 * `organization_id` de `resolveActiveOrg` (nunca de argumento), gate `admin`,
 * ler-mesclar-gravar no jsonb compartilhado `settings` preservando as outras
 * chaves, e auditoria do ato que abre a escrita sem decisão humana.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoExtracaoSilenciosa =
  | { ok: true; ligado: boolean }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_role"
        | "forbidden_tenant"
        | "mfa_required"
        | "erro_ao_gravar";
    };

export async function definirExtracaoSilenciosa(ligar: boolean): Promise<ResultadoExtracaoSilenciosa> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligar);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const crm = (settings.crm ?? {}) as Record<string, unknown>;
  const novo = { ...settings, crm: { ...crm, extracao_silenciosa: entrada.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[extracao-silenciosa] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.extracao_silenciosa_alterada",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/atendimento");
  revalidatePath("/app", "layout");

  return { ok: true, ligado: entrada.data };
}
