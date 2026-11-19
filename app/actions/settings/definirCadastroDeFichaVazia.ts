"use server";

/**
 * LIGAR E DESLIGAR "DADOS DE CADASTRO INFORMADOS AO ASSISTENTE ENTRAM SOZINHOS
 * NA FICHA VAZIA" — `organizations.settings.crm.cadastro_de_ficha_vazia`.
 *
 * Irmã de `definirTelefoneDeFichaVazia` (#2593), com a MESMA forma: service
 * role com `organization_id` de `resolveActiveOrg`, ler-mesclar-gravar o jsonb
 * (preserva as outras chaves de `settings` e de `crm`), gate `admin` e
 * auditoria do ato. DESLIGADA (o padrão): nome, CPF, e-mail, nascimento e
 * endereço ditos ao assistente viram proposta. LIGADA: entram no campo VAZIO
 * da ficha na hora (`lib/contacts/proposta-de-dado.ts`).
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoCadastroDeFichaVazia =
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

export async function definirCadastroDeFichaVazia(
  ligar: boolean,
): Promise<ResultadoCadastroDeFichaVazia> {
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
  const novo = { ...settings, crm: { ...crm, cadastro_de_ficha_vazia: entrada.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[cadastro-de-ficha-vazia] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.cadastro_de_ficha_vazia_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // O `crm` anterior NÃO vai para o metadata: ele carrega as outras chaves de
    // CRM da organização, e audit é lido por quem audita, não por quem opera a
    // tela. O que importa aqui é o booleano que mudou.
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/atendimento");
  // O layout monta o `ActiveOrg`; sem invalidar, a mudança só apareceria no
  // próximo recarregamento completo — a mesma razão das outras duas actions.
  revalidatePath("/app", "layout");

  return { ok: true, ligado: entrada.data };
}
