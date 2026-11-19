import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/products/:id — muda o que veio, não encosta no resto.
 * DELETE /api/v1/products/:id — remove do catálogo.
 *
 * O id vai no PATH, não no corpo, e o DELETE confere que a linha existia ANTES
 * de auditar: sem isso, um DELETE barrado pela RLS devolveria sucesso e gravaria
 * auditoria de uma mutação que não aconteceu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CAMPOS_DA_PRECIFICACAO, COLUNAS_DO_PRODUTO, ORIGEM_DA_PRECIFICACAO, produtoPatchSchema } from "@/lib/schemas/produtos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const corpo: unknown = await req.json().catch(() => null);
  const parsed = produtoPatchSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  // O `.partial()` do Zod 4 ainda aplica os `.default()` (ativo, estoque):
  // sem este filtro, editar o preço de um item desativado o reativava.
  const veio = new Set(Object.keys(corpo as object));
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => veio.has(k)));
  if (Object.keys(patch).length === 0) {
    return fail("validation_failed", t("Nada para alterar."), 422, { requestId });
  }

  const supabase = await createClient();
  // Item da Precificação: código, nome, categoria, preço, custo e situação são
  // dela. A sincronização de hora em hora desfaria a mudança, e um código novo
  // viraria item duplicado com o preço velho. Recusa em vez de dizer "salvo".
  const travados = CAMPOS_DA_PRECIFICACAO.filter((k) => k in patch);
  if (travados.length) {
    const { data: atual } = await supabase
      .from("catalog_products")
      .select("origem")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (atual?.origem === ORIGEM_DA_PRECIFICACAO) {
      return fail("state_conflict", t("Este item vem da Precificação: altere na Precificação."), 409, {
        requestId,
        details: { campos: travados },
      });
    }
  }
  const { data, error } = await supabase
    .from("catalog_products")
    .update(patch)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um produto com esse código."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar o produto.", 500, { requestId });
  }
  // `maybeSingle` devolve null quando a RLS barrou ou o id não é desta org — os
  // dois são "não existe para você", e 404 é a resposta honesta.
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_products")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao remover o produto.", 500, { requestId });
  if (!data) return fail("not_found", t("Produto não encontrado."), 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.deleted",
    resourceType: "catalog_products",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
