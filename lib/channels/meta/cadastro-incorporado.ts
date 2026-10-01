/**
 * O lado do SERVIDOR do Cadastro Incorporado v4: troca do `code` (30 s), conferência
 * do token, resolução do número, `register` (só número novo), `smb_app_data`
 * (só coexistência) e o arquivamento da sessão legada do mesmo número.
 *
 * Tudo que fala com a Graph vive aqui, por `baseDaGraph()` + `graphVersion()`.
 * Nada aqui grava a sessão: quem grava é `conectarCanalOficial` (o mesmo caminho
 * do formulário manual).
 */
import { randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";
import { getWahaClient } from "@/lib/waha/client";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_WAHA } from "../capabilities";
import { canonicalPhoneBR } from "../phone-variants";
import { mensagemDoErroDaMeta } from "./coexistencia";
import { baseDaGraph } from "./graph-base";

/** Motivos devolvidos ao usuário: CHAVES do dicionário (pt-BR), a rota traduz (ruling P13). */
export const FALHA_GENERICA_DA_META = "Não foi possível concluir a conexão com a Meta. Tente de novo em instantes; se persistir, refaça o fluxo.";
const M_OUTRO_APP = "O token devolvido não é do app desta instalação.";
const M_TOKEN_INVALIDO = "A Meta devolveu um token inválido.";
const M_SEM_PERMISSAO = "O token não tem as permissões do WhatsApp Business necessárias.";
const M_SEM_NUMERO = "A Meta não devolveu o número desta conta. Refaça o fluxo.";
const M_NAO_E_COEXISTENCIA = "O número não está marcado como coexistência. Refaça o fluxo escolhendo manter o número no celular.";
const M_VARIOS_NUMEROS = "A conta tem mais de um número e a Meta não disse qual foi cadastrado. Use o formulário manual.";
export const MOTIVOS_DO_CADASTRO: readonly string[] = [FALHA_GENERICA_DA_META, M_OUTRO_APP, M_TOKEN_INVALIDO, M_SEM_PERMISSAO, M_SEM_NUMERO, M_NAO_E_COEXISTENCIA, M_VARIOS_NUMEROS];

const ESCOPOS_EXIGIDOS = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

interface ErroGraph { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } }

export class ErroDaMeta extends Error {
  readonly codigo: number | null;
  readonly subcodigo: number | null;
  /** Texto cru da Meta/rede: só para log e auditoria, nunca para a tela. */
  readonly detalhe: string;
  constructor(codigo: number | null, subcodigo: number | null, cru: string) {
    super(mensagemDoErroDaMeta(codigo, subcodigo, FALHA_GENERICA_DA_META));
    this.name = "ErroDaMeta";
    this.codigo = codigo;
    this.subcodigo = subcodigo;
    this.detalhe = cru;
  }
}

const detalheDe = (err: unknown) => (err instanceof ErroDaMeta ? err.detalhe : String(err));
/** Frase para a tela: a mapeada da Meta, ou a genérica. Nunca texto cru. */
const motivoDe = (err: unknown) => (err instanceof ErroDaMeta ? err.message : FALHA_GENERICA_DA_META);

async function graph<T>(caminho: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...resto } = init;
  let res: Response;
  try {
    res = await fetch(`${baseDaGraph()}/${graphVersion()}${caminho}`, {
      ...resto,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(resto.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ErroDaMeta(null, null, err instanceof Error ? err.message : "fetch falhou");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: ErroGraph };
  if (!res.ok || body.error) {
    const e = body.error ?? {};
    throw new ErroDaMeta(e.code ?? null, e.error_subcode ?? null, e.error_data?.details ?? e.message ?? `http_${res.status}`);
  }
  return body;
}

export async function trocarCodigo(app: { appId: string; appSecret: string }, code: string): Promise<string> {
  const q = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, code });
  const r = await graph<{ access_token?: string }>(`/oauth/access_token?${q}`);
  if (!r.access_token) throw new ErroDaMeta(null, null, "troca sem access_token");
  return r.access_token;
}

export async function conferirToken(app: { appId: string; appSecret: string }, token: string): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const q = new URLSearchParams({ input_token: token, access_token: `${app.appId}|${app.appSecret}` });
  try {
    const r = await graph<{ data?: { app_id?: string; is_valid?: boolean; scopes?: string[] } }>(`/debug_token?${q}`);
    const d = r.data ?? {};
    if (d.app_id !== app.appId) return { ok: false, motivo: M_OUTRO_APP };
    if (!d.is_valid) return { ok: false, motivo: M_TOKEN_INVALIDO };
    const faltam = ESCOPOS_EXIGIDOS.filter((s) => !(d.scopes ?? []).includes(s));
    if (faltam.length) return { ok: false, motivo: M_SEM_PERMISSAO };
    return { ok: true };
  } catch (err) {
    logger.warn("[cadastro-incorporado] debug_token falhou", { error: detalheDe(err) });
    return { ok: false, motivo: motivoDe(err) };
  }
}

export interface NumeroDaConta { id: string; displayPhoneNumber: string | null; isOnBizApp: boolean }

export async function numerosDaConta(token: string, wabaId: string): Promise<NumeroDaConta[]> {
  // ponytail: uma página de até 100 números, como `conferirNumeroDaConta`.
  const r = await graph<{ data?: Array<{ id?: string; display_phone_number?: string; is_on_biz_app?: boolean }> }>(
    `/${wabaId}/phone_numbers?fields=id,display_phone_number,is_on_biz_app&limit=100`,
    { token },
  );
  return (r.data ?? []).filter((n): n is { id: string } & typeof n => typeof n.id === "string").map((n) => ({
    id: n.id,
    displayPhoneNumber: n.display_phone_number ?? null,
    isOnBizApp: n.is_on_biz_app === true,
  }));
}

export function escolherNumero(
  numeros: NumeroDaConta[],
  input: { phoneNumberId: string | null; coexistencia: boolean },
): { ok: true; numero: NumeroDaConta } | { ok: false; motivo: string } {
  const candidatos = input.phoneNumberId ? numeros.filter((n) => n.id === input.phoneNumberId) : numeros;
  if (candidatos.length === 0) return { ok: false, motivo: M_SEM_NUMERO };
  if (input.coexistencia) {
    const noApp = candidatos.find((n) => n.isOnBizApp);
    if (!noApp) return { ok: false, motivo: M_NAO_E_COEXISTENCIA };
    return { ok: true, numero: noApp };
  }
  if (candidatos.length > 1) return { ok: false, motivo: M_VARIOS_NUMEROS };
  return { ok: true, numero: candidatos[0]! };
}

/** PIN de verificação em duas etapas do número novo. CSPRNG, 6 dígitos. */
export function gerarPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function registrarNumero(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await graph(`/${phoneNumberId}/register`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
}

export async function pedirSincronizacao(
  token: string,
  phoneNumberId: string,
  tipo: "smb_app_state_sync" | "history",
): Promise<{ request_id: string } | { erro: string }> {
  try {
    const r = await graph<{ request_id?: string }>(`/${phoneNumberId}/smb_app_data`, {
      method: "POST",
      token,
      body: new URLSearchParams({ messaging_product: "whatsapp", sync_type: tipo }),
    });
    if (r.request_id) return { request_id: r.request_id };
    logger.warn("[cadastro-incorporado] smb_app_data sem request_id", { tipo });
    return { erro: FALHA_GENERICA_DA_META };
  } catch (err) {
    logger.warn("[cadastro-incorporado] smb_app_data falhou", { tipo, error: detalheDe(err) });
    return { erro: motivoDe(err) };
  }
}

/**
 * A Meta desconecta todos os aparelhos vinculados no onboarding: a sessão WAHA
 * deste mesmo número já caiu. Arquiva (não apaga: conversas ficam) e tenta
 * limpar a sessão no WAHA, sem falhar a conexão se o WAHA não responder.
 * Devolve o id arquivado, ou `null` se não havia.
 *
 * Roda ANTES de gravar a sessão oficial: o índice
 * `channel_sessions_phone_per_org_unique (organization_id, phone_number) where
 * archived_at is null` ainda tem a linha WAHA do mesmo número, e gravar a
 * oficial antes de arquivá-la é 23505 exatamente no caso da clínica.
 */
export async function arquivarSessaoLegadaDoNumero(
  admin: SupabaseClient,
  organizationId: string,
  phoneNumber: string,
): Promise<string | null> {
  // Só o provider legado é candidato: a sessão oficial (que ainda nem existe
  // quando isto roda, ruling P1) nunca entra no filtro.
  // O número vem da Meta formatado ("+55 27 99904-9879") e a linha WAHA pode
  // estar gravada com/sem "+" ou sem o 9 do celular: compara canônico, em JS
  // (uma org tem pouquíssimas sessões WAHA).
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, waha_session_name, phone_number")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_WAHA)
      .not("phone_number", "is", null);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null),
    () => base(),
  );
  if (error) throw new Error(`channel_sessions: ${error.message}`);
  const alvo = canonicalPhoneBR(phoneNumber);
  const legada = ((data ?? []) as Array<{ id: string; waha_session_name: string | null; phone_number: string | null }>).find(
    (l) => l.phone_number && canonicalPhoneBR(l.phone_number) === alvo,
  );
  if (!legada) return null;

  const now = new Date().toISOString();
  const { error: erroUpdate } = await admin
    .from("channel_sessions")
    .update({ archived_at: now, status: "STOPPED", last_status_change_at: now, status_reason: "substituida_pela_coexistencia" })
    .eq("organization_id", organizationId)
    .eq("id", legada.id);
  // Falha aqui lança ANTES do WAHA: derrubar a sessão sem arquivá-la deixaria o índice único ocupado.
  if (erroUpdate) throw new Error(`channel_sessions: ${erroUpdate.message}`);

  const waha = getWahaClient();
  if (waha && legada.waha_session_name) {
    try {
      await waha.logoutSession(legada.waha_session_name);
      await waha.deleteSession(legada.waha_session_name);
    } catch (err) {
      logger.warn("[cadastro-incorporado] sessão legada arquivada no banco, mas o WAHA não limpou", {
        organization_id: organizationId,
        session: legada.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return legada.id;
}
