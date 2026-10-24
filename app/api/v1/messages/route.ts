import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages — envia mensagem outbound (handler em ./_handler.ts).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { ritmoDaFila } from "@/lib/bonus/ritmo";
import { traduzir } from "@/lib/i18n/dicionario";
import { sendMessageSchema, validateRequest, type SendMessageInput } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

import { sendMessageHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  //
  // Aceita sessão de navegador OU token de servidor (`dsk_…` com `mcp:write`),
  // porque esta rota é a porta de envio de quem não tem navegador: o gateway do
  // CRM que está sendo absorvido, e qualquer integração server-to-server. A org
  // nunca vem do corpo; no ramo do token ela sai da linha do token.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "messages",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  // Rota que aceita Bearer (PUBLIC_PATHS) e envia WhatsApp: um laço aqui bane
  // o NÚMERO da operação. O teto por token e por organização é o único que existe.
  const teto = await tetoDeEscritaDoToken(authz, "messages", requestId);
  if (teto) return teto;
  const { supabase, organizationId, actor, idioma } = authz;

  let input;
  try {
    input = await validateRequest(sendMessageSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Ritmo da fila de leads antigos (bônus da equipe): só o envio de PESSOA. Mora
  // aqui, e não no `_handler.ts`, porque o handler também serve a IA e o MCP.
  // Falha aberta: `ritmoDaFila` nunca lança e devolve `pode` em qualquer erro.
  if (actor.type === "user") {
    const ritmo = await ritmoDaFila(createAdminClient(), organizationId, input.conversation_id);
    if (ritmo.tipo === "aguarde") {
      const n = String(ritmo.segundos);
      return fail(
        "bonus_ritmo",
        traduzir("Aguarde {n} s para mandar a próxima mensagem da fila (proteção do número).", idioma ?? "pt-BR").replace("{n}", n),
        429,
        { details: { aguarde_s: ritmo.segundos }, requestId, headers: { "Retry-After": n } },
      );
    }
    if (ritmo.tipo === "fora_da_janela") {
      return fail(
        "fora_da_janela_da_fila",
        traduzir("Fora do horário de envio do número ({inicio}h às {fim}h). A mensagem da fila sai dentro da janela.", idioma ?? "pt-BR")
          .replace("{inicio}", String(ritmo.inicio ?? 7))
          .replace("{fim}", String(ritmo.fim ?? 22)),
        422,
        { requestId },
      );
    }
  }

  try {
    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: organizationId,
        actor,
        requestId,
        idioma,
      },
      input as SendMessageInput,
    );
    return ok(message, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }
}
