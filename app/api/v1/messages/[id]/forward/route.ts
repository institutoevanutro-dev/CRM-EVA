/**
 * POST /api/v1/messages/[id]/forward — encaminha uma mensagem para outra
 * conversa da organização.
 *
 * Curta de propósito: autentica, valida a entrada, monta o `HandlerCtx` e
 * traduz o desfecho. O CORAÇÃO — ler a origem, recusar destino de fora, e
 * mandar o conteúdo pelo MESMO caminho de envio do Inbox (`sendMessageHandler`,
 * que audita `message.sent`) — mora em `lib/inbox/encaminhar-mensagem`.
 *
 * Portado do projeto original (DeskcommCRM, PR #2841 de @webtecnica).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { chaveDaRequisicao, comIdempotencia, type DesfechoIdempotente } from "@/lib/api/idempotency";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";
import { createClient } from "@/lib/supabase/server";
import type { Message } from "@/lib/types/messaging";

export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

const ENDPOINT = "POST /api/v1/messages/[id]/forward";
/** Encaminhar é enviar WhatsApp: um laço aqui manda a mesma mensagem em rajada. */
const TETO_POR_USUARIO = 20;
const JANELA_SEGUNDOS = 60;

/** O corpo: só a conversa de destino. O conteúdo vem da mensagem de origem. */
const corpoSchema = z.object({ conversation_id: z.string().uuid() });

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Escrita é agent+, a MESMA régua de `POST /api/v1/messages`: encaminhar é enviar.
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", t("Escolha uma conversa de destino."), 422, { requestId });
  }

  // O `apiClient` carimba Idempotency-Key em todo POST, e o hook
  // (`useEncaminharMensagem`) mantém UMA chave por intenção (mensagem + destino):
  // a retentativa de rede chega aqui com a mesma chave. Chave, quando vem, é UUID.
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const teto = await checkRateLimit(`mensagem-encaminhar:${authz.user.id}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  if (!teto.allowed) {
    return fail("rate_limited", t("Muitas tentativas seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(teto.limit),
        "X-RateLimit-Remaining": String(Math.max(0, teto.limit - teto.count)),
      },
    });
  }

  const supabase = await createClient();
  const encaminhar = () =>
    encaminharMensagem(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
        idioma: authz.user.idioma,
      },
      { messageId: id, conversationIdDestino: corpo.data.conversation_id },
    );
  try {
    const desfecho: DesfechoIdempotente<Message> =
      chave === null
        ? { tipo: "executou", resposta: await encaminhar(), status: 201 }
        : await comIdempotencia({
            db: supabase,
            organizationId: authz.org.orgId,
            endpoint: ENDPOINT,
            chave,
            // A mensagem de origem vem do path: ela faz parte da identidade.
            corpo: { message_id: id, conversation_id: corpo.data.conversation_id },
            executar: async () => ({ resposta: await encaminhar(), status: 201 }),
          });

    if (desfecho.tipo === "conflito") {
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    }
    return ok(desfecho.resposta, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        requestId,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
    }
    throw err;
  }
}
