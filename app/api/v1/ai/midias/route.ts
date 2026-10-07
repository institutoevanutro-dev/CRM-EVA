/**
 * GET  /api/v1/ai/midias — itens da biblioteca com a situação calculada e URL
 *      assinada (1 h) de cada variante, para pré-visualização na tela.
 * POST /api/v1/ai/midias — cria um item (sem arquivo; o arquivo sobe por
 *      /api/v1/ai/midias/:id/arquivo).
 *
 * manager+. Cliente de SESSÃO para a linha (RLS da 0326); admin só para assinar
 * URL no bucket privado `media-library`. Filtro por organização explícito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarMidiaSchema, variantesDoItem } from "@/lib/midias/esquemas";
import { BUCKET_DA_BIBLIOTECA, hojeNaClinica, situacaoDaMidia } from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const ENDPOINT = "/api/v1/ai/midias";

const COLUNAS_DA_MIDIA =
  "id, title, when_to_use, tags, variants, contains_person, consent_subject, consent_scope, consent_signed_at, consent_expires_at, consent_revoked_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_library_items")
    .select(COLUNAS_DA_MIDIA)
    .eq("organization_id", authz.org.orgId)
    .order("title", { ascending: true });
  if (error) return fail("internal_error", t("Erro ao ler a biblioteca de mídias."), 500, { requestId });

  const hoje = hojeNaClinica();
  const storage = createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA);
  const itens = await Promise.all(
    (data ?? []).map(async (linha) => {
      const variants = variantesDoItem(linha.variants, authz.org.orgId, linha.id);
      const variantes = await Promise.all(
        variants.map(async (v) => ({
          key: v.key,
          mime: v.mime,
          size_bytes: v.size_bytes,
          url: (await storage.createSignedUrl(v.storage_path, 3600)).data?.signedUrl ?? null,
        })),
      );
      const { variants: _bruto, ...resto } = linha;
      return { ...resto, situacao: situacaoDaMidia({ ...linha, variants }, hoje), variantes };
    }),
  );
  return ok({ itens }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarMidiaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const dados = parsed.data;
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  const supabase = await createClient();

  /** Lança em falha: o helper de idempotência não grava recibo de operação que falhou. */
  async function criar() {
    const { data: item, error } = await supabase
      .from("media_library_items")
      .insert({ organization_id: org.orgId, created_by_user_id: user.id, ...dados })
      .select("id")
      .single();
    if (error || !item) throw new Error("item");
    void audit({
      action: "media_library.item_created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "media_library_item",
      resourceId: item.id,
      requestId,
      metadata: { title: dados.title, contains_person: dados.contains_person ?? true },
    });
    return { id: item.id };
  }

  try {
    if (chave === null) return ok(await criar(), { requestId, status: 201 });
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: org.orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: dados,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, { requestId });
    }
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  }
}
