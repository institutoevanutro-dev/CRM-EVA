/**
 * O que os dois avisos (agendou, sinal pago) fazem igual: quem nunca vai, de
 * onde o paciente veio, e o envio por plataforma com livro-razão, tentativas e
 * aviso na Central. Cada handler só decide QUANDO e SOBRE O QUÊ.
 *
 * ─── Uma vez por alvo, evento e plataforma ──────────────────────────────────
 *
 * O livro-razão (`ad_conversion_dispatches`) tem índice único por (agendamento,
 * plataforma, evento) e por (negócio, plataforma, evento). `sent` nunca volta.
 * Antes da rede a linha é tomada (`sending`, com a contagem de tentativas como
 * trava otimista), então dois drenos não enviam dois. A segunda camada é o
 * `event_id`/`orderId` determinístico, que a plataforma deduplica.
 *
 * ─── Falha ──────────────────────────────────────────────────────────────────
 *
 * Transitória: nova tentativa com espera crescente (1, 2, 4… até 60 min), até
 * `MAX_TENTATIVAS`. O `retry` do `event_log` não conta tentativa, então quem
 * conta é a linha. Permanente, ou tentativas esgotadas: linha `error` com o
 * código curto e UM aviso aberto na Central por organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { ehPlataformaConhecida, enviarConversao, PLATAFORMAS } from "@/lib/plataformas-de-anuncio/registry";
import {
  EVENTO_AGENDOU,
  type ConversaoDeAgendamento,
  type PlataformaDeAnuncio,
} from "@/lib/plataformas-de-anuncio/types";

export const MAX_TENTATIVAS = 8;
/** Linha `sending` mais velha que isto é de um dreno que morreu: pode ser retomada. */
const EM_VOO_MS = 10 * 60 * 1000;
export const ESPERA_DE_LEITURA_MS = 5 * 60 * 1000;

/** 1, 2, 4, 8, 16, 32, 60, 60 minutos. */
export function esperaDaTentativa(tentativas: number): number {
  return Math.min(60, 2 ** Math.max(0, tentativas - 1)) * 60_000;
}

export const COLUNAS_DO_CONTATO =
  "phone_number, email, is_blocked, ai_opt_out, is_anonymized, is_merged_into, inbox_hidden_at, source_metadata";

export interface Contato {
  phone_number: string | null;
  email: string | null;
  is_blocked: boolean | null;
  ai_opt_out: boolean | null;
  is_anonymized: boolean | null;
  is_merged_into: string | null;
  inbox_hidden_at: string | null;
  source_metadata: unknown;
}

export interface LinhaDoLivro {
  id: string;
  platform: string;
  status: string;
  attempts: number;
  attempted_at: string;
  next_attempt_at: string | null;
}

/** Por que um contato nunca vai. A ordem é só a do texto; qualquer um basta. */
export function motivoDeExclusao(c: Contato): string | null {
  if (c.is_anonymized) return "contato_anonimizado";
  if (c.is_merged_into) return "contato_fundido";
  if (c.is_blocked) return "contato_bloqueado";
  if (c.ai_opt_out) return "sempre_atendimento_humano";
  if (c.inbox_hidden_at) return "contato_oculto";
  return null;
}

export const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * De onde o contato veio, e os cliques — lidos do registro de primeiro toque
 * (0164). O clique da Meta vem do payload CRU (`ad_raw`), nunca de
 * `ad_source_id`: os dois extratores gravam ali o id do ANÚNCIO quando não há
 * clique, e mandá-lo como `ctwa_clid` seria afirmar um clique que não existiu.
 */
export function lerOrigem(sourceMetadata: unknown): {
  plataforma: PlataformaDeAnuncio | null;
  cliqueMeta: string | null;
  cliqueGoogle: string | null;
} {
  const meta = objeto(sourceMetadata);
  const bruto = objeto(meta.ad_raw);
  const plataforma = ehPlataformaConhecida(meta.ad_platform) ? meta.ad_platform : null;
  return {
    plataforma,
    cliqueMeta: plataforma === "meta_ads" ? (texto(bruto.ctwa_clid) ?? texto(bruto.ctwaClid)) : null,
    cliqueGoogle: texto(meta.gclid) ?? texto(bruto.gclid),
  };
}

export function resultadoDe(consumerKey: string) {
  return (status: HandlerResult["status"], detail?: string, retryAt?: number): HandlerResult => ({
    consumer_key: consumerKey,
    status,
    detail,
    ...(retryAt !== undefined ? { retry_at: new Date(retryAt).toISOString() } : {}),
  });
}

/** O alvo de uma linha do livro-razão: o agendamento ou o negócio. */
export type Alvo = { coluna: "appointment_id" | "lead_id"; id: string };

export async function lerLivro(
  admin: SupabaseClient,
  organizationId: string,
  alvo: Alvo,
  evento: string,
): Promise<LinhaDoLivro[] | null> {
  const { data, error } = await admin
    .from("ad_conversion_dispatches")
    .select("id, platform, status, attempts, attempted_at, next_attempt_at")
    .eq("organization_id", organizationId)
    .eq(alvo.coluna, alvo.id)
    .eq("event_name", evento);
  return error ? null : ((data ?? []) as LinhaDoLivro[]);
}

/** Encerra sem envio o que ainda não saiu. `sent` e `error` ficam como estão. */
export async function encerrar(
  admin: SupabaseClient,
  organizationId: string,
  linhas: LinhaDoLivro[],
  motivo: string,
): Promise<void> {
  const abertas = linhas.filter((l) => l.status === "pending" || l.status === "sending").map((l) => l.id);
  if (!abertas.length) return;
  const { error } = await admin
    .from("ad_conversion_dispatches")
    .update({ status: "skipped", reason: motivo, next_attempt_at: null })
    .eq("organization_id", organizationId)
    .in("id", abertas);
  if (error) logger.error("[conversoes] não encerrei pendentes", { motivo, error: error.message });
}

async function abrirAviso(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio,
  evento: string,
  codigo: string,
) {
  const nome = plataforma === "meta_ads" ? "Meta" : "Google Ads";
  const qual = evento === EVENTO_AGENDOU ? "de agendamento" : "de sinal pago";
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "ad_conversion_failing",
    severity: "warn",
    title: `O aviso ${qual} para o ${nome} não está saindo`,
    body:
      `A plataforma recusou ou não respondeu depois de várias tentativas (código ${codigo}). ` +
      "Confira a conexão em Configurações › Conversões. Nenhum dado do paciente aparece neste aviso.",
  });
  // 23505: já há um aberto para a organização (índice parcial da 0391).
  if (error && error.code !== "23505") {
    logger.error("[conversoes] aviso na Central falhou", { organizationId, error: error.message });
  }
}

/**
 * Manda `conversao` para cada plataforma em que ela cabe, uma vez só. Quem chama
 * já excluiu contato e alvo que não podem sair.
 */
export async function despachar(args: {
  admin: SupabaseClient;
  alvo: Alvo;
  conversao: ConversaoDeAgendamento;
  livro: LinhaDoLivro[];
  somenteDeAnuncio: boolean;
  origemDoContato: PlataformaDeAnuncio | null;
  agora: number;
  resultado: ReturnType<typeof resultadoDe>;
}): Promise<HandlerResult> {
  const { admin, alvo, conversao, livro, somenteDeAnuncio, agora, resultado } = args;
  const org = conversao.organizationId;
  const evento = conversao.evento;

  let proxima: number | null = null;
  const reagendar = (quando: number) => {
    proxima = proxima === null ? quando : Math.min(proxima, quando);
  };
  const detalhes: string[] = [];

  for (const plataforma of PLATAFORMAS) {
    const linha = livro.find((l) => l.platform === plataforma);
    if (linha?.status === "sent" || linha?.status === "error") continue;

    if (somenteDeAnuncio && args.origemDoContato !== plataforma) {
      if (linha) await encerrar(admin, org, [linha], "fora_da_origem");
      detalhes.push(`${plataforma}:fora_da_origem`);
      continue;
    }

    const credencial = await lerCredencial(admin, org, plataforma, evento);
    if (!credencial.ok) {
      if (linha) await encerrar(admin, org, [linha], credencial.motivo);
      detalhes.push(`${plataforma}:${credencial.motivo}`);
      continue;
    }

    if (linha?.status === "sending" && agora - Date.parse(linha.attempted_at) < EM_VOO_MS) {
      reagendar(Date.parse(linha.attempted_at) + EM_VOO_MS);
      continue;
    }
    if (linha?.next_attempt_at && Date.parse(linha.next_attempt_at) > agora) {
      reagendar(Date.parse(linha.next_attempt_at));
      continue;
    }

    // Tomar a linha ANTES da rede. Quem perde a corrida volta em 1 minuto e
    // encontra `sent` ou `sending`.
    const tomadaEm = new Date(agora).toISOString();
    let id: string | null = null;
    if (!linha) {
      const { data, error } = await admin
        .from("ad_conversion_dispatches")
        .insert({
          organization_id: org,
          [alvo.coluna]: alvo.id,
          platform: plataforma,
          event_name: evento,
          event_id: conversao.eventoId,
          status: "sending",
          attempts: 0,
          attempted_at: tomadaEm,
        })
        .select("id")
        .maybeSingle();
      if (error) {
        reagendar(agora + 60_000);
        continue;
      }
      id = (data as { id: string } | null)?.id ?? null;
    } else {
      const { data } = await admin
        .from("ad_conversion_dispatches")
        .update({ status: "sending", attempted_at: tomadaEm })
        .eq("organization_id", org)
        .eq("id", linha.id)
        .eq("status", linha.status)
        .eq("attempts", linha.attempts)
        .select("id");
      id = (data as { id: string }[] | null)?.[0]?.id ?? null;
    }
    if (!id) {
      reagendar(agora + 60_000);
      continue;
    }

    const tentativas = (linha?.attempts ?? 0) + 1;
    const r = await enviarConversao(credencial.credencial, conversao);

    if (r.tipo === "ok") {
      await admin
        .from("ad_conversion_dispatches")
        .update({
          status: "sent",
          attempts: tentativas,
          sent_at: new Date().toISOString(),
          reason: null,
          error_code: null,
          next_attempt_at: null,
        })
        .eq("organization_id", org)
        .eq("id", id);
      detalhes.push(`${plataforma}:enviado`);
      continue;
    }

    if (r.tipo === "transitorio" && tentativas < MAX_TENTATIVAS) {
      const quando = Date.now() + esperaDaTentativa(tentativas);
      await admin
        .from("ad_conversion_dispatches")
        .update({
          status: "pending",
          attempts: tentativas,
          reason: "tentando_de_novo",
          error_code: r.codigo,
          next_attempt_at: new Date(quando).toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", id);
      reagendar(quando);
      continue;
    }

    await admin
      .from("ad_conversion_dispatches")
      .update({
        status: "error",
        attempts: tentativas,
        reason: r.tipo === "permanente" ? "recusado_pela_plataforma" : "sem_resposta",
        error_code: r.codigo,
        next_attempt_at: null,
      })
      .eq("organization_id", org)
      .eq("id", id);
    await abrirAviso(admin, org, plataforma, evento, r.codigo);
    detalhes.push(`${plataforma}:erro`);
  }

  if (proxima !== null) return resultado("retry", "aguardando_nova_tentativa", proxima);
  return resultado("ok", detalhes.join(",") || "nada_a_enviar");
}
