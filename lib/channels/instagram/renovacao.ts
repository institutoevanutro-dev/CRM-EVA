/**
 * Renovação do token de 60 dias do Instagram — e o aviso quando ela falha.
 *
 * Toda consulta/escrita que nomeia o provider mora aqui (o `lint:channels`
 * proíbe fora de `lib/channels/`); a rota do cron só chama esta rodada.
 *
 * ─── Query string, não cabeçalho ────────────────────────────────────────────
 *
 * A doc oficial (`developers.facebook.com/documentation/instagram-platform/
 * instagram-api-with-instagram-login/business-login`) manda o token de
 * `refresh_access_token` como parâmetro `access_token` na QUERY, diferente do
 * resto da Graph API deste arquivo-irmão (`graph.ts`), que usa
 * `Authorization: Bearer`. A URL nunca é logada — ela carrega o token — só o
 * status da resposta.
 *
 * ─── O aviso reusa a identidade de dedupe do vigia de saúde ────────────────
 *
 * `channel_session_health` (organization_id, channel_session_id) é a MESMA
 * linha que `lib/channels/health.ts` usa para não abrir dois avisos da mesma
 * sessão — aqui com um episódio PRÓPRIO (`INSTAGRAM_TOKEN_EXPIRADO`), para não
 * fechar sozinho um aviso que a sonda de saúde abriu por outro motivo, nem
 * vice-versa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { REF_KIND_SESSAO } from "@/lib/channels/health";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_INSTAGRAM } from "../capabilities";
import { BASE_DO_INSTAGRAM } from "./graph";

/** Renova quando faltam menos de 15 dias — folga contra uma rodada perdida. */
const JANELA_DE_RENOVACAO_MS = 15 * 24 * 60 * 60 * 1000;

/** Marca o episódio aberto por ESTA rotina, na mesma linha que o vigia usa. */
const EPISODIO_TOKEN_EXPIRADO = "INSTAGRAM_TOKEN_EXPIRADO";

/** Teto por rodada: renovar centenas de contas num tick estouraria a cota da Meta. */
const TETO_POR_RODADA = 50;

export function precisaRenovar(expiraEm: Date, agora: Date): boolean {
  return expiraEm.getTime() - agora.getTime() < JANELA_DE_RENOVACAO_MS;
}

export interface SessaoParaRenovar {
  id: string;
  organization_id: string;
  ig_username: string | null;
  ig_token_encrypted: string;
}

/** As sessões `meta_instagram` ativas com token a vencer dentro da janela. */
export async function sessoesParaRenovar(
  admin: SupabaseClient,
  agora: Date,
): Promise<SessaoParaRenovar[]> {
  const limite = new Date(agora.getTime() + JANELA_DE_RENOVACAO_MS).toISOString();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_username, ig_token_encrypted")
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .not("ig_token_encrypted", "is", null)
    .lte("ig_token_expires_at", limite)
    .limit(TETO_POR_RODADA);
  if (error || !data) return [];
  return data as SessaoParaRenovar[];
}

export interface TokenRenovado {
  token: string;
  expiraEm: Date;
}

/**
 * GET `refresh_access_token` — token em claro, nunca logado (nem na URL).
 * `null` em qualquer falha (rede, resposta não-ok, corpo sem os campos
 * esperados): o chamador decide o que fazer, nunca lança.
 */
export async function renovarToken(tokenAtual: string): Promise<TokenRenovado | null> {
  const url = `${BASE_DO_INSTAGRAM}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tokenAtual)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.info("[instagram.renovacao] recusada", { status: res.status });
      return null;
    }
    const corpo = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!corpo.access_token || !corpo.expires_in) return null;
    return { token: corpo.access_token, expiraEm: new Date(Date.now() + corpo.expires_in * 1000) };
  } catch (err) {
    logger.info("[instagram.renovacao] falhou", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Grava o token novo cifrado e a validade nova — sempre filtrado pela organização. */
export async function gravarTokenRenovado(
  admin: SupabaseClient,
  sessao: Pick<SessaoParaRenovar, "id" | "organization_id">,
  tokenCifrado: string,
  expiraEm: Date,
): Promise<void> {
  await admin
    .from("channel_sessions")
    .update({ ig_token_encrypted: tokenCifrado, ig_token_expires_at: expiraEm.toISOString() })
    .eq("id", sessao.id)
    .eq("organization_id", sessao.organization_id);
}

function apelidoDaSessao(sessao: SessaoParaRenovar): string {
  return sessao.ig_username ? `@${sessao.ig_username}` : "sem nome";
}

/** Abre o aviso — uma vez por episódio, pela mesma identidade que o vigia de saúde usa. */
async function avisarFalhaDeRenovacao(admin: SupabaseClient, sessao: SessaoParaRenovar): Promise<void> {
  const { data: linha } = await admin
    .from("channel_session_health")
    .select("escalated_status")
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .maybeSingle();
  if ((linha?.escalated_status as string | null) === EPISODIO_TOKEN_EXPIRADO) return;

  await admin.from("agent_inbox_items").insert({
    organization_id: sessao.organization_id,
    kind: "channel_number_alert",
    severity: "critical",
    title: `Instagram ${apelidoDaSessao(sessao)} precisa ser reconectado`,
    body: "A renovação automática da chave falhou. Vá em Conexões para reconectar.",
    ref_kind: REF_KIND_SESSAO,
    ref_id: sessao.id,
  });
  await admin.from("channel_session_health").upsert(
    {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      status: "TOKEN_EXPIRADO",
      escalated_status: EPISODIO_TOKEN_EXPIRADO,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,channel_session_id" },
  );
}

/** Fecha o aviso — só quando o episódio aberto é o desta rotina (nunca o da sonda de saúde). */
async function resolverAvisoDeRenovacao(admin: SupabaseClient, sessao: SessaoParaRenovar): Promise<void> {
  const { data: linha } = await admin
    .from("channel_session_health")
    .select("escalated_status")
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .maybeSingle();
  if ((linha?.escalated_status as string | null) !== EPISODIO_TOKEN_EXPIRADO) return;

  await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", sessao.organization_id)
    .eq("ref_kind", REF_KIND_SESSAO)
    .eq("ref_id", sessao.id)
    .eq("status", "open");
  await admin.from("channel_session_health").upsert(
    {
      organization_id: sessao.organization_id,
      channel_session_id: sessao.id,
      status: "WORKING",
      escalated_status: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,channel_session_id" },
  );
}

export interface ResumoDaRenovacao {
  examinadas: number;
  renovadas: number;
  falhas: number;
}

/**
 * A rodada inteira: examina, renova, grava, avisa (ou resolve) — e só audita
 * quando renovou alguma coisa. Cada sessão é tratada sozinha: uma falha não
 * derruba as outras.
 */
export async function renovarTokensDoInstagram(
  admin: SupabaseClient,
  agora: Date,
): Promise<ResumoDaRenovacao> {
  const resumo: ResumoDaRenovacao = { examinadas: 0, renovadas: 0, falhas: 0 };
  const sessoes = await sessoesParaRenovar(admin, agora);

  for (const sessao of sessoes) {
    resumo.examinadas += 1;
    try {
      const tokenAtual = await decryptWebhookSecret(admin, sessao.ig_token_encrypted);
      const renovado = tokenAtual ? await renovarToken(tokenAtual) : null;
      if (!renovado) {
        resumo.falhas += 1;
        await avisarFalhaDeRenovacao(admin, sessao);
        continue;
      }

      const cifrado = await encryptWebhookSecret(admin, renovado.token);
      if (!cifrado) {
        resumo.falhas += 1;
        await avisarFalhaDeRenovacao(admin, sessao);
        continue;
      }

      await gravarTokenRenovado(admin, sessao, cifrado, renovado.expiraEm);
      await resolverAvisoDeRenovacao(admin, sessao);
      resumo.renovadas += 1;
    } catch (err) {
      logger.warn("[instagram.renovacao] falhou numa sessão", {
        sessionId: sessao.id,
        detail: err instanceof Error ? err.message : "erro",
      });
      resumo.falhas += 1;
    }
  }

  // Só audita rodada que renovou algo — rodada vazia (ou só falhas) não é
  // mutação (tests/unit/cron-audita-so-quando-ha-efeito.test.ts).
  if (resumo.renovadas > 0) {
    await audit({
      action: "channel.instagram_token_refreshed",
      metadata: { examinadas: resumo.examinadas, renovadas: resumo.renovadas, falhas: resumo.falhas },
    });
  }

  return resumo;
}
