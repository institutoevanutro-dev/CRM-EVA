/**
 * Wrappers canônicos de API (sucesso e erro).
 *
 * Toda rota `/api/v1/*` DEVE usar `ok()` / `fail()` em vez de NextResponse direto.
 * Garante:
 *  - Formato consistente { data, meta? } / { error: { code, message, details? } }
 *  - Header X-Request-Id correlacionando com audit log
 *  - Status codes corretos (200/201/204/400/401/403/404/409/422/429/500)
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type { ApiErrorCode } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type CursorMeta = {
  cursor?: string | null;
  has_more?: boolean;
  total?: number | null;
};

export type ApiSuccess<T> = {
  data: T;
  meta?: CursorMeta & Record<string, unknown>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type OkOptions = {
  status?: 200 | 201 | 204;
  meta?: ApiSuccess<unknown>["meta"];
  requestId?: string;
  headers?: HeadersInit;
};

export function ok<T>(data: T, opts: OkOptions = {}): NextResponse<ApiSuccess<T>> {
  const { status = 200, meta, requestId, headers } = opts;
  const body: ApiSuccess<T> = meta ? { data, meta } : { data };

  const res = NextResponse.json(body, { status, headers });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
}

type FailOptions = {
  details?: unknown;
  requestId?: string;
  headers?: HeadersInit;
};

export function fail(
  code: ApiErrorCode | (string & {}),
  message: string,
  status: number,
  opts: FailOptions = {},
): NextResponse<ApiError> {
  const requestId = opts.requestId ?? randomUUID();
  // M2: ~400 rotas fazem `fail("internal_error", err.message, 500)` e a
  // mensagem do Postgres (tabela, constraint, valor da chave) ia para a tela.
  // Em produção o 500 sai genérico; a mensagem real fica no log, amarrada pelo
  // X-Request-Id que a resposta também leva. 502/503 ficam de fora: ali a
  // mensagem costuma ser a instrução escrita para quem opera ("WAHA não
  // configurado"), não um erro de banco.
  if (status === 500 && process.env.NODE_ENV === "production") {
    logger.error("api.internal_error", { code, message, requestId, details: opts.details });
    message = "Erro interno. Tente de novo.";
    opts = { ...opts, details: undefined };
  }
  const body: ApiError = {
    error: {
      code,
      message,
      ...(opts.details !== undefined ? { details: opts.details } : {}),
    },
  };

  const res = NextResponse.json(body, { status, headers: opts.headers });
  res.headers.set("X-Request-Id", requestId);
  return res;
}

// -----------------------------------------------------------------------------
// Atalhos comuns
// -----------------------------------------------------------------------------

export const noContent = (requestId?: string) => {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("X-Request-Id", requestId ?? randomUUID());
  return res;
};
