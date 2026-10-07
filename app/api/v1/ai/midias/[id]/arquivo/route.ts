/**
 * POST   multipart `variante` (A|B) + `arquivo` — sobe ou TROCA o arquivo da
 *        variante. O item, o id e as automações que apontam para ele não mudam.
 * DELETE `?variante=` — tira a variante do item.
 * manager+. Tipo FAREJADO pelos bytes (validateOutboundMedia). Bucket privado,
 * só service_role (migration 0326). Organização sempre da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { variantesDoItem } from "@/lib/midias/esquemas";
import {
  BUCKET_DA_BIBLIOTECA,
  TIPOS_ACEITOS_NA_BIBLIOTECA,
  hojeNaClinica,
  situacaoDaMidia,
  type Variante,
} from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const EXTENSAO: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
};
const ehVariante = (v: unknown): v is "A" | "B" => v === "A" || v === "B";

async function lerItem(orgId: string, id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_library_items")
    .select("id, updated_at, variants, contains_person, consent_signed_at, consent_expires_at, consent_revoked_at")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return { erro: true as const };
  if (!data) return { item: null };
  return { item: { ...data, variants: variantesDoItem(data.variants, orgId, id) } };
}

async function gravarVariantes(orgId: string, id: string, variants: Variante[], lidoEm: string) {
  const supabase = await createClient();
  // Concorrência otimista: só grava se ninguém mexeu na linha desde a leitura.
  const { data, error } = await supabase
    .from("media_library_items")
    .update({ variants })
    .eq("organization_id", orgId)
    .eq("id", id)
    .eq("updated_at", lidoEm)
    .select("id");
  if (error) return "erro" as const;
  return (data ?? []).length > 0 ? ("ok" as const) : ("conflito" as const);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > MAX_MEDIA_BYTES + 64 * 1024) {
    return fail("payload_too_large", t("O arquivo pode ter no máximo 50 MB."), 413, { requestId });
  }
  const form = await req.formData().catch(() => null);
  const variante = form?.get("variante");
  const arquivo = form?.get("arquivo");
  if (!ehVariante(variante) || !(arquivo instanceof File)) {
    return fail("invalid_request", t("Escolha a variante e o arquivo."), 400, { requestId });
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const mime = (arquivo.type || "").split(";")[0]!.trim().toLowerCase();
  const validacao = validateOutboundMedia(mime, arquivo.size, bytes);
  if (!validacao.ok) {
    const status = validacao.code === "payload_too_large" ? 413 : validacao.code === "unsupported_media_type" ? 415 : 422;
    return fail(validacao.code, t(validacao.message), status, { requestId });
  }
  if (!(TIPOS_ACEITOS_NA_BIBLIOTECA as readonly string[]).includes(mime)) {
    return fail("unsupported_media_type", t("Use imagem JPG, PNG ou WEBP, ou vídeo MP4."), 415, { requestId });
  }

  // Lê o item ANTES de subir: item de outra org não gera arquivo órfão.
  const lido = await lerItem(orgId, id);
  if ("erro" in lido) return fail("internal_error", t("Erro ao salvar o arquivo."), 500, { requestId });
  if (!lido.item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const caminho = `${orgId}/${id}/${variante}-${randomUUID()}.${EXTENSAO[mime]}`;
  const storage = createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA);
  const { error: erroUp } = await storage.upload(caminho, Buffer.from(bytes), { contentType: mime, upsert: false });
  if (erroUp) {
    logger.error("[midias] upload falhou", { requestId, detail: erroUp.message });
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  const anterior = lido.item.variants.find((v) => v.key === variante);
  const novas: Variante[] = [
    ...lido.item.variants.filter((v) => v.key !== variante),
    { key: variante, storage_path: caminho, mime, size_bytes: arquivo.size },
  ].sort((a, b) => a.key.localeCompare(b.key));
  const gravou = await gravarVariantes(orgId, id, novas, lido.item.updated_at);
  if (gravou !== "ok") {
    await storage.remove([caminho]);
    if (gravou === "conflito") return fail("state_conflict", t("A mídia mudou enquanto você enviava. Tente de novo."), 409, { requestId });
    return fail("internal_error", t("Erro ao salvar o arquivo."), 500, { requestId });
  }
  // O antigo sai DEPOIS do novo gravado: falhar aqui deixa órfão, nunca item sem arquivo.
  if (anterior) {
    const { error: erroRemove } = await storage.remove([anterior.storage_path]);
    if (erroRemove) logger.warn("[midias] arquivo antigo ficou no bucket após a troca", { id, requestId, detail: erroRemove.message });
  }

  void audit({
    action: "media_library.file_replaced",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "media_library_item",
    resourceId: id,
    requestId,
    metadata: { variante, mime, bytes: arquivo.size, substituiu: Boolean(anterior) },
  });
  return ok({ key: variante, situacao: situacaoDaMidia({ ...lido.item, variants: novas }, hojeNaClinica()) }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;
  const variante = new URL(req.url).searchParams.get("variante");
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });
  if (!ehVariante(variante)) return fail("invalid_request", t("Variante desconhecida."), 400, { requestId });

  const lido = await lerItem(orgId, id);
  if ("erro" in lido) return fail("internal_error", t("Erro ao remover o arquivo."), 500, { requestId });
  if (!lido.item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });
  const alvo = lido.item.variants.find((v) => v.key === variante);
  const novas = lido.item.variants.filter((v) => v.key !== variante);
  if (alvo) {
    const gravou = await gravarVariantes(orgId, id, novas, lido.item.updated_at);
    if (gravou === "conflito") return fail("state_conflict", t("A mídia mudou enquanto você removia. Tente de novo."), 409, { requestId });
    if (gravou === "erro") return fail("internal_error", t("Erro ao remover o arquivo."), 500, { requestId });
    const { error: erroRemove } = await createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA).remove([alvo.storage_path]);
    if (erroRemove) logger.warn("[midias] arquivo ficou no bucket após remover a variante", { id, requestId, detail: erroRemove.message });
    void audit({
      action: "media_library.file_removed",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "media_library_item",
      resourceId: id,
      requestId,
      metadata: { variante },
    });
  }
  return ok({ key: variante, situacao: situacaoDaMidia({ ...lido.item, variants: novas }, hojeNaClinica()) }, { requestId });
}
