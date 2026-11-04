/**
 * GET /api/v1/prontuario/midias/{message_id} — o Prontuário baixa o PDF ou a
 * foto (escopo `prontuario:media:read`).
 *
 * Inexistente, de outra organização, não elegível, WebP/HEIC (o Prontuário os
 * recusa pela lista sem baixar) e caminho fora da mensagem respondem o MESMO
 * 404. O Prontuário traduz só o status: 404 nao_encontrado, 409
 * ainda_nao_disponivel, 413 grande_demais, 429 limite, resto fora_do_ar.
 *
 * `Content-Disposition: attachment` SEM `filename`: o Prontuário usa o nome da
 * lista, e sem nome no cabeçalho não há o que injetar.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";
import { cabecalhosDeMidia } from "@/lib/messaging/media/servir";
import { isMessageMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { authorizeProntuario } from "@/lib/prontuario/contacts";
import { LIMITE_DA_ROTA_BYTES, MIMES_ACEITOS } from "@/lib/prontuario/exames";
import { buscarMidia } from "@/lib/prontuario/midias";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const opts = { requestId, headers: { "Cache-Control": "no-store" } };
  const indisponivel = () => fail("not_found", "Arquivo indisponível.", 404, opts);

  const authorized = await authorizeProntuario(req, "prontuario:media:read", requestId);
  if (!authorized.ok) {
    authorized.response.headers.set("Cache-Control", "no-store");
    return authorized.response;
  }
  const { auth } = authorized;
  const org = auth.organizationId;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return indisponivel();
  const messageId = id.data.toLowerCase();

  if (!(await checkRateLimit(`prontuario-media-get:${org}:${auth.apiTokenId}`, 60, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, {
      requestId,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });

  let midia;
  try {
    midia = await buscarMidia(getRequestPool(), { organizationId: org, messageId });
  } catch (error) {
    logger.error("prontuario.midias.busca_falhou", { request_id: requestId, error: (error as Error).message });
    return fail("internal_error", "Consulta indisponível.", 503, opts);
  }
  if (!midia || !(MIMES_ACEITOS as readonly string[]).includes(midia.mime)) return indisponivel();
  if (midia.pendente) return fail("midia_ainda_nao_disponivel", "O arquivo ainda está chegando ao CRM.", 409, opts);
  if (Number(midia.size_bytes) > LIMITE_DA_ROTA_BYTES) return fail("payload_too_large", "Arquivo acima de 15 MB.", 413, opts);

  const caminho = midia.storage_path ?? "";
  const arquivo = caminho.split("/").pop() ?? "";
  if (!isMessageMediaPathOwnedBy(caminho, org, midia.conversation_id, midia.message_id) || !arquivo.startsWith(`${midia.message_id}.`)) {
    logger.warn("prontuario.midia.caminho_fora_da_mensagem", { message_id: midia.message_id, request_id: requestId });
    return indisponivel();
  }

  const { data, error } = await createAdminClient().storage.from("whatsapp-media").download(caminho);
  if (error || !data) {
    if (/not\s+found|not_found|no such/i.test(error?.message ?? "")) return indisponivel();
    logger.error("prontuario.midias.download_falhou", { request_id: requestId, message_id: midia.message_id });
    return fail("internal_error", "Consulta indisponível.", 503, opts);
  }
  // ponytail: arquivo inteiro em memória (padrão da casa); teto de 15 MiB.
  const buffer = await data.arrayBuffer();
  if (buffer.byteLength > LIMITE_DA_ROTA_BYTES) return fail("payload_too_large", "Arquivo acima de 15 MB.", 413, opts);

  auditarLeitura({
    action: "prontuario.media_downloaded",
    actorApiTokenId: auth.apiTokenId,
    organizationId: org,
    resourceType: "message",
    resourceId: midia.message_id,
    requestId,
    metadata: { mime: midia.mime, size_bytes: buffer.byteLength, contact_id: midia.contact_id },
  });
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      ...cabecalhosDeMidia(midia.mime),
      "Content-Disposition": "attachment",
      "Content-Length": String(buffer.byteLength),
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
  });
}
