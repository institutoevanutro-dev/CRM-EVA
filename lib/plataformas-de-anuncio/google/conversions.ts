/**
 * O transporte de conversões do Google Ads: conversão aprimorada para leads
 * (`uploadClickConversions` com `userIdentifiers`). Só o agendamento.
 *
 * Irmão de `../meta/conversions.ts`, mesmo contrato. Desenho portado do
 * upstream (melgarafael/DeskcommCRM #1566): renovar o access token a cada envio
 * (o Google expira em ~1h, e cache seria um relógio a mais para errar),
 * `partialFailure: true` com leitura do resultado por item, e só códigos
 * enumerados no erro — a mensagem do Google pode repetir o que foi enviado.
 *
 * ─── A credencial é da ORGANIZAÇÃO, não da instalação ────────────────────────
 *
 * Diferente do upstream, que usa um app OAuth da instalação e um fluxo de
 * consentimento. Aqui a organização cola cliente OAuth e refresh token (o
 * developer token é opcional desde 09/09/2026) na tela, todos cifrados. Não há escopo novo no app OAuth da
 * Agenda: pedir `adwords` lá reabriria a verificação dele no Google.
 *
 * ─── Sem `gclid` é normal ───────────────────────────────────────────────────
 *
 * Nenhum caminho de entrada captura `gclid` hoje. A conversão aprimorada para
 * leads casa pelo telefone (e e-mail) hasheado; o `gclid` entra quando houver.
 */
import { z } from "zod";

import { logger } from "@/lib/logger";
import { emailHashGoogle, telefoneHashGoogle } from "../identificadores";
import type {
  ConversaoDeAgendamento,
  CredencialGoogle,
  ResultadoDeEnvio,
  TransporteDeConversao,
} from "../types";

/**
 * Versão medida pelo upstream em 18/09/2026 na página de desativação do Google
 * (v25: a mais nova lançada, desativação prevista para ago/2027). Bump aqui.
 */
export const VERSAO_DA_API_DO_GOOGLE_ADS = "v25";

const ENDERECO_DE_TOKEN = "https://oauth2.googleapis.com/token";
const ENDERECO_BASE = "https://googleads.googleapis.com";
const TEMPO_LIMITE_MS = 10_000;

/** `yyyy-MM-dd HH:mm:ss+00:00`, em UTC — o formato exato da API. */
function formatarDataDeConversao(quando: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${quando.getUTCFullYear()}-${p(quando.getUTCMonth() + 1)}-${p(quando.getUTCDate())} ` +
    `${p(quando.getUTCHours())}:${p(quando.getUTCMinutes())}:${p(quando.getUTCSeconds())}+00:00`
  );
}

/** O corpo exato que sai. Exportado para o teste vigiar campo a campo. */
export function montarCorpoGoogle(
  credencial: CredencialGoogle,
  conversao: ConversaoDeAgendamento,
): Record<string, unknown> | null {
  const identificadores: Record<string, string>[] = [];
  const telefone = telefoneHashGoogle(conversao.telefone);
  const email = emailHashGoogle(conversao.email);
  if (telefone) identificadores.push({ hashedPhoneNumber: telefone });
  if (email) identificadores.push({ hashedEmail: email });
  if (!identificadores.length && !conversao.cliqueGoogle) return null;

  const conversaoGoogle: Record<string, unknown> = {
    conversionAction: `customers/${credencial.customerId}/conversionActions/${credencial.conversionActionId}`,
    conversionDateTime: formatarDataDeConversao(conversao.ocorridoEm),
    // Dedup do lado do Google: o mesmo papel do `event_id` da Meta.
    orderId: conversao.eventoId,
  };
  if (identificadores.length) conversaoGoogle.userIdentifiers = identificadores;
  if (conversao.cliqueGoogle) conversaoGoogle.gclid = conversao.cliqueGoogle;

  return { conversions: [conversaoGoogle], partialFailure: true };
}

const respostaDoUpload = z.object({
  partialFailureError: z
    .object({
      code: z.number().optional(),
      details: z
        .array(
          z
            .object({
              errors: z.array(z.object({ errorCode: z.record(z.string(), z.string()) })).optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .optional(),
  results: z.array(z.object({ conversionAction: z.string().min(1).optional() }).passthrough()).optional(),
});

const TRANSITORIOS = new Set([
  "INTERNAL_ERROR",
  "RESOURCE_EXHAUSTED",
  "RESOURCE_TEMPORARILY_EXHAUSTED",
  "UNAVAILABLE",
]);

/** Porte do upstream (#1566): sucesso é UM resultado com a ação de conversão. */
export function lerResultadoDoUpload(bruto: unknown): ResultadoDeEnvio {
  const lida = respostaDoUpload.safeParse(bruto);
  if (!lida.success) return { tipo: "transitorio", codigo: "google_resposta_invalida" };
  const erro = lida.data.partialFailureError;
  if (erro && (erro.code || erro.details?.length)) {
    const codigos = (erro.details ?? [])
      .flatMap((d) => d.errors ?? [])
      .flatMap((e) => Object.values(e.errorCode))
      .filter((c) => /^[A-Z_]+$/.test(c));
    const codigo = (codigos[0] ?? "PARTIAL_FAILURE").slice(0, 60);
    return codigos.some((c) => TRANSITORIOS.has(c))
      ? { tipo: "transitorio", codigo: `google_${codigo}` }
      : { tipo: "permanente", codigo: `google_${codigo}` };
  }
  if (lida.data.results?.length !== 1 || !lida.data.results[0]?.conversionAction) {
    return { tipo: "transitorio", codigo: "google_sem_confirmacao" };
  }
  return { tipo: "ok" };
}

function classificaHttp(status: number, statusDoGoogle: string | null): ResultadoDeEnvio {
  if (status === 429 || status >= 500 || (statusDoGoogle && TRANSITORIOS.has(statusDoGoogle))) {
    return { tipo: "transitorio", codigo: `http_${status}` };
  }
  return {
    tipo: "permanente",
    codigo: statusDoGoogle && /^[A-Z_]+$/.test(statusDoGoogle) ? `google_${statusDoGoogle}` : `http_${status}`,
  };
}

async function renovarAccessToken(
  credencial: CredencialGoogle,
): Promise<{ ok: true; token: string } | { ok: false; resultado: ResultadoDeEnvio }> {
  let resposta: Response;
  try {
    resposta = await fetch(ENDERECO_DE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credencial.refreshToken,
        client_id: credencial.clientId,
        client_secret: credencial.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, resultado: { tipo: "transitorio", codigo: "rede" } };
  }
  const lido = (await resposta.json().catch(() => null)) as { access_token?: unknown } | null;
  if (resposta.ok && typeof lido?.access_token === "string" && lido.access_token) {
    return { ok: true, token: lido.access_token };
  }
  if (resposta.status >= 500) {
    return { ok: false, resultado: { tipo: "transitorio", codigo: `http_${resposta.status}` } };
  }
  // `invalid_grant`/`invalid_client`: refresh token revogado ou cliente errado.
  return { ok: false, resultado: { tipo: "permanente", codigo: "google_autorizacao_invalida" } };
}

async function enviar(
  credencial: CredencialGoogle,
  conversao: ConversaoDeAgendamento,
): Promise<ResultadoDeEnvio> {
  const corpo = montarCorpoGoogle(credencial, conversao);
  if (!corpo) return { tipo: "permanente", codigo: "sem_identificador" };

  const token = await renovarAccessToken(credencial);
  if (!token.ok) return token.resultado;

  const headers: Record<string, string> = {
    authorization: `Bearer ${token.token}`,
    "content-type": "application/json",
  };
  // Só quando gravado: o Google ignora o cabeçalho desde 09/09/2026 e avisou
  // que uma versão futura da API vai recusá-lo.
  if (credencial.developerToken) headers["developer-token"] = credencial.developerToken;
  if (credencial.loginCustomerId) headers["login-customer-id"] = credencial.loginCustomerId;

  let resposta: Response;
  try {
    resposta = await fetch(
      `${ENDERECO_BASE}/${VERSAO_DA_API_DO_GOOGLE_ADS}/customers/${credencial.customerId}:uploadClickConversions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
        cache: "no-store",
      },
    );
  } catch {
    return { tipo: "transitorio", codigo: "rede" };
  }

  if (resposta.ok) return lerResultadoDoUpload(await resposta.json().catch(() => null));

  const lido = (await resposta.json().catch(() => null)) as { error?: { status?: unknown } } | null;
  const statusDoGoogle = typeof lido?.error?.status === "string" ? lido.error.status : null;
  logger.warn("[conversoes.google] envio recusado", {
    status: resposta.status,
    statusDoGoogle,
    alvoId: conversao.alvoId,
  });
  return classificaHttp(resposta.status, statusDoGoogle);
}

export const transporteGoogle: TransporteDeConversao<CredencialGoogle> = {
  plataforma: "google_ads",
  enviar,
};

export const INTERNOS = { formatarDataDeConversao, classificaHttp } as const;
