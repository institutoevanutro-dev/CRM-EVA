/**
 * GET /api/v1/message-templates/:id/midias/:indice — a PRÉVIA de uma imagem da
 * resposta rápida (o item da Biblioteca de mídia na posição `indice`).
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica):
 * aqui a imagem é um item da biblioteca, então esta rota não guarda nem serve
 * arquivo próprio — ela confere e redireciona para uma URL assinada CURTA (60 s)
 * do bucket privado `media-library`, como a lista da biblioteca já faz.
 *
 * A resposta é lida pela SESSÃO (a RLS de `message_templates` decide quem vê),
 * o item pela service role SEMPRE filtrado pela organização da sessão, e o
 * caminho do arquivo passa por `variantesDoItem` (só `{org}/{item}/…`). O envio
 * não passa por aqui: ele manda `media_library_item_id` ao `POST /messages`,
 * que confere o termo de uso de imagem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { variantesDoItem } from "@/lib/midias/esquemas";
import { BUCKET_DA_BIBLIOTECA } from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string; indice: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id, indice } = await params;
  const naoAchou = () => fail("not_found", t("Imagem não encontrada."), 404, { requestId });

  const posicao = Number(indice);
  if (!Number.isInteger(posicao) || posicao < 0) return naoAchou();

  const supabase = await createClient();
  const { data: linha, error } = await supabase
    .from("message_templates")
    .select("media_item_ids")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao ler a imagem."), 500, { requestId });
  const itemId = ((linha as { media_item_ids: string[] | null } | null)?.media_item_ids ?? [])[posicao];
  if (!itemId) return naoAchou();

  const admin = createAdminClient();
  const { data: item } = await admin
    .from("media_library_items")
    .select("id, variants")
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .maybeSingle();
  if (!item) return naoAchou();
  const variante = variantesDoItem((item as { variants: unknown }).variants, orgId, itemId).find((v) =>
    v.mime.startsWith("image/"),
  );
  if (!variante) return naoAchou();

  const { data: assinada } = await admin.storage.from(BUCKET_DA_BIBLIOTECA).createSignedUrl(variante.storage_path, 60);
  if (!assinada?.signedUrl) return naoAchou();
  return new Response(null, {
    status: 302,
    headers: { Location: assinada.signedUrl, "Cache-Control": "private, no-store", "X-Request-Id": requestId },
  });
}
