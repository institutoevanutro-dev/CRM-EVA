import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/bulk: a camada de lote da Inbox.
 *
 * Porte do upstream #2909 (fatia F1 de #2484, de @webtecnica).
 *
 * UMA rota para as ações em lote (`close`, `archive`, `mark-read`, `pause-ai`,
 * `transfer`), discriminada por `action`. Cada id é encaminhado, UM A UM, ao
 * MESMO handler da conversa individual (`../[id]/...`). Quem decide permissão,
 * organização (da sessão, nunca do corpo) e auditoria continua sendo ele: uma
 * entrada de auditoria por conversa, nenhuma agregada. O fechamento, portanto,
 * vai pelo `fn_service_status` da rota `[id]/close`, e o arquivamento pelo
 * PATCH de status, que usa a mesma RPC.
 *
 * O que esta rota acrescenta:
 *  1. o portão da CHAMADA: `requireRole("agent")` antes de qualquer item;
 *  2. o TETO por chamada (`TETO_DO_LOTE`), recusado com 422 `bulk_too_large`;
 *  3. o RELATÓRIO por item, 200 mesmo com recusas, com o `request_id` de cada
 *     subchamada.
 *
 * Nenhuma das ações envia mensagem. `reactivate-bot` ficou de fora no fork de
 * propósito (ver `bulkConversationActionSchema`).
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { bulkConversationActionSchema, validateRequest } from "@/lib/schemas";
import type { BulkConversationActionInput } from "@/lib/schemas";

import { POST as fecharUmaConversa } from "../[id]/close/route";
import { POST as marcarComoLida } from "../[id]/mark-read/route";
import { POST as pausarAutomatico } from "../[id]/pause-ai/route";
import { POST as transferirUmaConversa } from "../[id]/transfer/route";
import { PATCH as atualizarUmaConversa } from "../[id]/route";

export const dynamic = "force-dynamic";

/** Quantas conversas uma chamada aceita: o tamanho de página da lista. */
export const TETO_DO_LOTE = 100;

interface ResultadoDoItem {
  id: string;
  feito: boolean;
  codigo?: string;
  motivo?: string;
  request_id?: string;
}

async function classificar(res: Response, id: string): Promise<ResultadoDoItem> {
  const requestId = res.headers.get("X-Request-Id") ?? undefined;
  if (res.ok) return { id, feito: true, request_id: requestId };
  let codigo = "internal_error";
  let motivo = "Não foi possível concluir a ação nesta conversa.";
  try {
    const corpo = (await res.json()) as { error?: { code?: string; message?: string } };
    if (corpo.error?.code) codigo = corpo.error.code;
    if (corpo.error?.message) motivo = corpo.error.message;
  } catch {
    // Resposta sem corpo JSON: o código e a mensagem padrão bastam.
  }
  return { id, feito: false, codigo, motivo, request_id: requestId };
}

function requestDoItem(
  req: NextRequest,
  id: string,
  caminho: string,
  metodo: "POST" | "PATCH",
  corpo: Record<string, unknown>,
): NextRequest {
  // O cookie da sessão é lido pelos handlers via `next/headers`, não deste
  // request; o corpo leva só o que a ação pede, jamais organização.
  return new NextRequest(new URL(`/api/v1/conversations/${id}${caminho}`, req.url), {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctxDoItem = (id: string) => ({ params: Promise.resolve({ id }) });

async function executarNoItem(
  req: NextRequest,
  input: BulkConversationActionInput,
  id: string,
): Promise<Response> {
  switch (input.action) {
    case "close":
      return fecharUmaConversa(requestDoItem(req, id, "/close", "POST", {}), ctxDoItem(id));
    case "archive":
      return atualizarUmaConversa(
        requestDoItem(req, id, "", "PATCH", { status: "archived" }),
        ctxDoItem(id),
      );
    case "mark-read":
      return marcarComoLida(requestDoItem(req, id, "/mark-read", "POST", {}), ctxDoItem(id));
    case "pause-ai":
      return pausarAutomatico(requestDoItem(req, id, "/pause-ai", "POST", {}), ctxDoItem(id));
    case "transfer":
      return transferirUmaConversa(
        requestDoItem(req, id, "/transfer", "POST", {
          to_user_id: input.to_user_id,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
        ctxDoItem(id),
      );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let input: BulkConversationActionInput;
  try {
    input = await validateRequest(bulkConversationActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.ids.length > TETO_DO_LOTE) {
    return fail(
      "bulk_too_large",
      `${t("Máximo")} ${TETO_DO_LOTE} ${t("conversas por chamada.")}`,
      422,
      { requestId },
    );
  }

  // Um item por vez, na ordem pedida e sem repetir id. Cada item acontece ou é
  // recusado sozinho: um handler que estoura recusa só aquele item.
  const resultados: ResultadoDoItem[] = [];
  for (const id of new Set(input.ids)) {
    try {
      resultados.push(await classificar(await executarNoItem(req, input, id), id));
    } catch (err) {
      resultados.push({
        id,
        feito: false,
        codigo: "internal_error",
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const feitos = resultados.filter((r) => r.feito).length;
  return ok(
    {
      acao: input.action,
      teto: TETO_DO_LOTE,
      total: resultados.length,
      feitos,
      recusados: resultados.length - feitos,
      resultados,
    },
    { requestId },
  );
}
