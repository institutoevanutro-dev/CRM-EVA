/**
 * GET /api/v1/prontuario/contacts/{id}/midias?dias=60 — o Prontuário lista PDF
 * e fotos que o paciente mandou pelo WhatsApp (escopo `prontuario:media:read`).
 *
 * A organização vem da linha do token, nunca da URL. Contato inexistente, de
 * outra organização, anonimizado ou unido devolve `{data: []}`: nenhum oráculo
 * de existência. A regra mora em `lib/prontuario/midias.ts`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";
import { authorizeProntuario } from "@/lib/prontuario/contacts";
import { JANELA_DO_PRONTUARIO_DIAS } from "@/lib/prontuario/exames";
import { itemDaLista, listarMidiasDoContato } from "@/lib/prontuario/midias";

export const dynamic = "force-dynamic";

const diasSchema = z.coerce.number().int().min(1).max(180).default(JANELA_DO_PRONTUARIO_DIAS);

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const opts = { requestId, headers: { "Cache-Control": "no-store" } };
  const authorized = await authorizeProntuario(req, "prontuario:media:read", requestId);
  if (!authorized.ok) {
    authorized.response.headers.set("Cache-Control", "no-store");
    return authorized.response;
  }
  const { auth } = authorized;

  // 404, não 422: o Prontuário lê 422 como "CRM fora do ar".
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return fail("not_found", "Arquivo indisponível.", 404, opts);
  const contactId = id.data.toLowerCase();

  const query = new URL(req.url).searchParams;
  const brutos = query.getAll("dias");
  const dias = diasSchema.safeParse(brutos[0] ?? undefined);
  if (brutos.length > 1 || !dias.success) return fail("validation_failed", "Período inválido.", 422, opts);

  if (!(await checkRateLimit(`prontuario-media-list:${auth.organizationId}:${auth.apiTokenId}`, 60, 60)).allowed)
    return fail("rate_limited", "Tente novamente em um minuto.", 429, {
      requestId,
      headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });

  let linhas;
  try {
    linhas = await listarMidiasDoContato(getRequestPool(), {
      organizationId: auth.organizationId,
      contactId,
      dias: dias.data,
    });
  } catch (error) {
    logger.error("prontuario.midias.lista_falhou", { request_id: requestId, error: (error as Error).message });
    return fail("internal_error", "Consulta indisponível.", 503, opts);
  }

  const itens = linhas.map(itemDaLista);
  auditarLeitura({
    action: "prontuario.media_listed",
    actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId,
    resourceType: "contact",
    resourceId: contactId,
    requestId,
    metadata: { quantidade: itens.length, dias: dias.data, ids: itens.map((i) => i.message_id) },
  });
  return ok(itens, opts);
}
