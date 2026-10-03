import { BodyLimitError, readLimitedFormData } from "@/lib/http/limited-body";
import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/notes/media — upload do ANEXO DA NOTA INTERNA
 * (issue #1863, F3).
 *
 * Mesmo desenho da rota irmã `../media`, com UMA diferença que é o ponto inteiro
 * desta rota: o bucket é `internal-media`, e não `whatsapp-media`.
 *
 *   · `whatsapp-media` é o bucket do CANAL DO CLIENTE, com o ciclo de vida da
 *     mídia de mensagem (reserva, expiração em 24h, limpeza — migration 0300).
 *   · `internal-media` nasce fora desse ciclo e fora do caminho de envio:
 *     a nota não passa por `useSendMessage`, não vira mensagem, não chega ao
 *     cliente. É a razão de existir do bucket criado pela migration 0303.
 *
 * O path segue o MESMO molde da rota irmã — `{org}/{conversa}/note-{uuid}.{ext}`
 * — porque é o que `isMediaPathOwnedBy` valida e o que a RLS/posse por organização
 * espera: o prefixo da org e o da conversa vêm antes do nome do arquivo.
 *
 * Sem `transcodificarNotaDeVoz`: aquele conversor existe para o CANAL ACEITAR o
 * arquivo (o WhatsApp recusa webm). A nota não sai para lugar nenhum, então o
 * container gravado é o que o render vai ler — converter aqui só quebraria o
 * arquivo que o próprio navegador acabou de subir.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;

  // Escrita é agent+ (viewer é read-only) — mesmo gate da rota irmã, que é a
  // da própria capacidade. Sessão de navegador OU token de servidor.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "conversation_notes",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // Fora de PUBLIC_PATHS hoje: o proxy recusa Bearer sem cookie antes daqui.
  // O teto é defesa em profundidade e passa a valer no dia em que a rota
  // entrar na lista. Anexo de nota é escrita real no bucket.
  const teto = await tetoDeEscritaDoToken(authz, "conversation_notes", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const activeOrg = { orgId: authz.organizationId };
  // Mesmo motivo da rota irmã: no ramo do token não há cookie de sessão, então o
  // client de sessão seria anônimo e a RLS devolveria zero linha. Quem protege é
  // o filtro explícito de organization_id, que vale nos dois ramos.
  const supabase = authz.supabase;

  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", t("Erro ao validar conversa."), 500, { requestId });
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Guard de DoS: rejeita pelo Content-Length ANTES de bufferizar o corpo.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES + 1_048_576) {
    return fail("payload_too_large", t("Arquivo acima de 50MB."), 413, { requestId });
  }

  let form: FormData;
  try {
    form = await readLimitedFormData(req, MAX_MEDIA_BYTES + 1_048_576);
  } catch (error) {
    return fail("invalid_request", "Unable to read upload.", error instanceof BodyLimitError ? error.status : 400, { requestId });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  // Os bytes vão junto: o `file.type` é do cliente e mente quando quer (SVG
  // rotulado `image/png`) — mesma régua da rota irmã.
  const buffer = Buffer.from(await file.arrayBuffer());
  const verdict = validateOutboundMedia(mime, file.size, buffer);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const storagePath = `${activeOrg.orgId}/${conversationId}/note-${randomUUID()}.${extFromMime(mime)}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("internal-media")
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (upErr) {
    console.error("[conversations.notes.media] upload failed", upErr.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  // Mesma ação da rota irmã; `bucket` distingue o anexo da nota do da mensagem.
  void audit({
    action: "conversation.media_uploaded",
    actorUserId: authz.via === "session" ? authz.actor.id : null,
    organizationId: activeOrg.orgId,
    resourceType: "conversation",
    resourceId: conversationId,
    requestId,
    metadata: {
      actor_type: authz.actor.type,
      ...(authz.via === "token" ? { actor_id: authz.actor.id } : {}),
      bucket: "internal-media",
      storage_path: storagePath,
      media_mime: mime,
      media_size_bytes: buffer.length,
    },
  });

  return ok(
    {
      storage_path: storagePath,
      // O mime e o tamanho do arquivo QUE FOI GUARDADO — é o que o card da nota
      // renderiza depois, e o que a cascata de LGPD leva no export.
      media_mime: mime,
      media_size_bytes: buffer.length,
      kind: verdict.kind,
    },
    { requestId },
  );
}
