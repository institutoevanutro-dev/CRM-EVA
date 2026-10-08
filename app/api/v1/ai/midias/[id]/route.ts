// app/api/v1/ai/midias/[id]/route.ts
/**
 * PATCH  /api/v1/ai/midias/:id — edita nome, quando usar, etiquetas, "mostra
 *        pessoa", registra o termo ou revoga. Revogar é imediato: a fatia 2
 *        confere a situação no envio.
 * DELETE /api/v1/ai/midias/:id — apaga o item e, depois, os arquivos.
 * manager+. Item de outra organização responde 404 (não vaza existência).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { editarMidiaSchema, variantesDoItem } from "@/lib/midias/esquemas";
import { BUCKET_DA_BIBLIOTECA, hojeNaClinica, situacaoDaMidia } from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const COLUNAS_DA_RESPOSTA = "id, variants, contains_person, consent_signed_at, consent_expires_at, consent_revoked_at";
type ItemDaResposta = {
  id: string;
  variants: unknown;
  contains_person: boolean;
  consent_signed_at: string | null;
  consent_expires_at: string | null;
  consent_revoked_at: string | null;
};
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const parsed = editarMidiaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { consent, revogar, ...campos } = parsed.data;
  const supabase = await createClient();

  // Revogar é definitivo para o termo que a causou: reabrir exige um termo NOVO.
  let atual: ItemDaResposta | null = null;
  if (consent || revogar) {
    const { data, error: erroLeitura } = await supabase
      .from("media_library_items")
      .select(COLUNAS_DA_RESPOSTA)
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (erroLeitura) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
    if (!data) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });
    atual = data;
    if (consent && data.consent_revoked_at && consent.signed_at <= hojeNaClinica(new Date(data.consent_revoked_at))) {
      return fail("validation_failed", t("Para voltar a usar, registre um termo novo, assinado depois da revogação."), 422, { requestId });
    }
  }

  const mudanca: Record<string, unknown> = { ...campos };
  const acoes: AuditAction[] = [];
  if (Object.keys(campos).length > 0) acoes.push("media_library.item_updated");
  if (consent) {
    Object.assign(mudanca, {
      consent_subject: consent.subject,
      consent_scope: consent.scope,
      consent_signed_at: consent.signed_at,
      consent_expires_at: consent.expires_at,
      consent_revoked_at: null,
    });
    acoes.push("media_library.consent_recorded");
  }
  // Já revogada: mantém a data original (idempotente), sem segunda gravação nem segunda auditoria.
  if (revogar && !atual?.consent_revoked_at) {
    mudanca.consent_revoked_at = new Date().toISOString();
    acoes.push("media_library.consent_revoked");
  }

  let item = atual;
  if (Object.keys(mudanca).length > 0) {
    const { data, error } = await supabase
      .from("media_library_items")
      .update(mudanca)
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .select(COLUNAS_DA_RESPOSTA)
      .maybeSingle();
    if (error) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
    item = data;
  }
  if (!item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  for (const action of acoes) {
    void audit({
      action,
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "media_library_item",
      resourceId: id,
      requestId,
      metadata:
        action === "media_library.consent_recorded"
          ? { expires_at: consent?.expires_at ?? null }
          : action === "media_library.item_updated"
            ? { fields: Object.keys(campos), ...(campos.contains_person !== undefined ? { contains_person: campos.contains_person } : {}) }
            : {},
    });
  }
  const situacao = situacaoDaMidia({ ...item, variants: variantesDoItem(item.variants, authz.org.orgId, id) }, hojeNaClinica());
  return ok({ id, situacao }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("media_library_items")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, title, variants")
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao apagar a mídia."), 500, { requestId });
  if (!item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  // A linha sai primeiro: arquivo órfão é só espaço; linha sem arquivo seria item quebrado.
  const caminhos = variantesDoItem(item.variants, authz.org.orgId, id).map((x) => x.storage_path);
  if (caminhos.length > 0) {
    const { error: erroRemove } = await createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA).remove(caminhos);
    if (erroRemove) logger.warn("[midias] arquivos ficaram no bucket após apagar o item", { id, requestId, detail: erroRemove.message });
  }
  void audit({
    action: "media_library.item_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "media_library_item",
    resourceId: id,
    requestId,
    metadata: { title: item.title },
  });
  return ok({ id }, { requestId });
}
