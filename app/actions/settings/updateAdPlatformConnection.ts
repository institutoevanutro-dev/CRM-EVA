"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

/**
 * Conectar a conta de anúncios (Meta ou Google Ads) para receber o aviso de
 * agendamento — pela tela. Desligado até alguém ligar aqui.
 *
 * ─── O que isto fecha (invariante 6 da doutrina de restrição de canal) ──────
 *
 * "Nenhum mecanismo de backend pode depender de estado configurável que não
 * tenha tela para ver, tela para mudar, e caminho visível de falha." O handler
 * de conversões nasceria violando isso: sem esta tela ele seria operável só por
 * quem sabe dar UPDATE numa tabela, que é o mesmo que não existir — a lição
 * cara da #144, onde rodízio e visibilidade existiam INTEIROS e um contribuidor
 * abriu issue pedindo a feature que já estava construída.
 *
 * ─── Por que admin da ORGANIZAÇÃO, e não platform admin ─────────────────────
 *
 * O oposto de `updateGoogleOAuth.ts`, e de propósito. Lá o objeto é a
 * INSTALAÇÃO (o `redirect_uri` sai do `NEXT_PUBLIC_APP_URL`). Aqui o objeto é a
 * CONTA DE ANÚNCIOS de um negócio: numa agência que hospeda dois clientes, cada
 * um tem o seu dataset, e exigir platform admin faria o dono do próprio tráfego
 * depender de quem hospeda para uma decisão que é dele.
 *
 * ─── NUNCA em claro ─────────────────────────────────────────────────────────
 *
 * Se `fn_encrypt_oauth` não puder cifrar, o save RECUSA. Cair para texto puro
 * trocaria "não dá para configurar" por "está configurado e desprotegido", e o
 * segundo não tem sintoma. Mesma decisão de `updateGoogleOAuth.ts` e de
 * `app/api/v1/channels/official/route.ts`.
 *
 * O token escreve na conta de anúncios do cliente: vazá-lo deixa terceiro
 * injetar conversão falsa e envenenar o otimizador de quem paga a mídia.
 */
export type UpdateAdPlatformConnectionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "cifra_indisponivel"
        | "erro_ao_gravar";
      details?: unknown;
    };

const digitos = (min: number, max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/-/g, ""))
    .pipe(z.string().regex(new RegExp(`^\\d{${min},${max}}$`), "só dígitos"));

/**
 * Segredo OPCIONAL: vazio = "mantenha o que está gravado", NUNCA "apague". Um
 * salvamento distraído não pode derrubar o envio. Para PARAR existe `enabled`.
 */
const segredo = (min: number) => z.string().trim().min(min).max(2000).optional();

const metaSchema = z.object({
  platform: z.literal("meta_ads"),
  dataset_id: digitos(5, 32),
  access_token: segredo(20),
  /** Enquanto preenchido, os eventos vão como teste e não contam. */
  test_event_code: z.string().trim().max(64).nullable().optional(),
  enabled: z.boolean(),
});

const googleSchema = z.object({
  platform: z.literal("google_ads"),
  customer_id: digitos(6, 12),
  login_customer_id: z.union([digitos(6, 12), z.literal("")]).nullable().optional(),
  conversion_action_id: digitos(1, 20),
  client_id: z.string().trim().min(10).max(200),
  client_secret: segredo(8),
  refresh_token: segredo(10),
  developer_token: segredo(10),
  enabled: z.boolean(),
});

const entradaSchema = z.discriminatedUnion("platform", [metaSchema, googleSchema]);

export type AdPlatformConnectionInput = z.input<typeof entradaSchema>;

export async function updateAdPlatformConnection(
  input: AdPlatformConnectionInput,
): Promise<UpdateAdPlatformConnectionResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!escreveComoPlatformAdmin(authUser) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  // Depois do papel: quem nem tem o papel recebe a verdade sobre ele.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const entrada = parsed.data;

  const valores: Record<string, unknown> = {
    organization_id: activeOrg.orgId,
    platform: entrada.platform,
    enabled: entrada.enabled,
    updated_by: authUser.id,
  };
  // Cada segredo preenchido é cifrado; sem cifra o save RECUSA (nunca em claro).
  const segredos: Array<[string, string | undefined]> = [];
  let metadata: Record<string, unknown>;

  if (entrada.platform === "meta_ads") {
    valores.dataset_id = entrada.dataset_id;
    valores.test_event_code = entrada.test_event_code?.trim() || null;
    segredos.push(["access_token_encrypted", entrada.access_token]);
    metadata = {
      platform: entrada.platform,
      enabled: entrada.enabled,
      dataset_id: entrada.dataset_id,
      token_trocado: Boolean(entrada.access_token),
      em_teste: Boolean(entrada.test_event_code?.trim()),
    };
  } else {
    valores.google_customer_id = entrada.customer_id;
    valores.google_login_customer_id = entrada.login_customer_id || null;
    valores.google_conversion_action_id = entrada.conversion_action_id;
    valores.google_oauth_client_id = entrada.client_id;
    segredos.push(
      ["google_oauth_client_secret_encrypted", entrada.client_secret],
      ["google_refresh_token_encrypted", entrada.refresh_token],
      ["google_developer_token_encrypted", entrada.developer_token],
    );
    metadata = {
      platform: entrada.platform,
      enabled: entrada.enabled,
      customer_id: entrada.customer_id,
      conversion_action_id: entrada.conversion_action_id,
      // O QUE mudou, jamais o valor.
      segredos_trocados: segredos.filter(([, v]) => Boolean(v)).map(([coluna]) => coluna),
    };
  }

  for (const [coluna, valor] of segredos) {
    if (!valor) continue;
    const cifrado = await encryptWebhookSecret(admin, valor);
    if (!cifrado) return { ok: false, error: "cifra_indisponivel" };
    valores[coluna] = cifrado;
  }

  // `upsert`: a linha não existe em quem nunca conectou, e um `update` casaria
  // zero linhas devolvendo SUCESSO. `onConflict` é o índice único da 0213.
  const { error } = await admin
    .from("ad_platform_connections")
    .upsert(valores, { onConflict: "organization_id,platform" });

  if (error) return { ok: false, error: "erro_ao_gravar", details: error.message };

  const hdrs = await headers();
  await audit({
    action: "ad_platform_connection.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    requestId: hdrs.get("x-request-id") ?? undefined,
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: hdrs.get("user-agent") ?? undefined,
    metadata,
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
