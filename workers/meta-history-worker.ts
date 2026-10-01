/**
 * Processa um pedaço do histórico do celular (webhook `history`, coexistência).
 *
 * O que NÃO faz, de propósito: IA, lead, automação, notificação, carimbo da
 * conversa (`fn_mark_conversation_message` mexeria em `last_inbound_at`, que
 * é a janela de 24 h — a Meta não honra janela aberta por mensagem anterior ao
 * onboarding — e em não-lidas). Os três gatilhos do banco são desarmados pela
 * marca `metadata.importada_do_historico` (migration 0297).
 *
 * Idempotente por `unique (organization_id, external_id)`: reprocessar o
 * mesmo pedaço conta duplicadas e devolve `ok`.
 *
 * Uma mensagem que não entra (CHECK, dado torto) é pulada e contada (ruling
 * P4): um pedaço de 180 dias não pode virar evento morto por uma linha exótica.
 *
 * ponytail: insert sequencial por mensagem. Medir o tamanho típico de chunk no
 * dia da conexão; lote com `on conflict do nothing` só se passar de ~500.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerCoexistencia } from "@/lib/channels/meta/coexistencia";
import { gravarCoexistencia } from "@/lib/channels/meta/conectar-canal-oficial";
import { pedirPersistenciaDeMidia, resolverContatoEConversa, tipoDoCrm } from "@/lib/channels/meta/ingest";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const META_HISTORY_CONSUMER_KEY = "meta-history-worker";
/** A Graph só serve mídia recente; mais velha que isto vira `midia_indisponivel`. */
const JANELA_DE_MIDIA_MS = 14 * 24 * 60 * 60 * 1000;

interface MensagemCrua {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  [k: string]: unknown;
}
interface Thread {
  id?: string;
  messages?: MensagemCrua[];
}

function digitos(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}
/** Com/sem o 9 e com/sem `+`: a mesma régua do inbound (ruling P15c). */
function mesmoNumero(a: unknown, b: unknown): boolean {
  const da = digitos(a);
  const db = digitos(b);
  return Boolean(da && db) && canonicalPhoneBR(`+${da}`) === canonicalPhoneBR(`+${db}`);
}
const resultado = (status: HandlerResult["status"], detail: string): HandlerResult => ({
  consumer_key: META_HISTORY_CONSUMER_KEY,
  status,
  detail,
});

export async function processarChunkDeHistorico(
  row: EventRow,
  admin: SupabaseClient = createAdminClient(),
): Promise<HandlerResult> {
  const orgId = row.organization_id;
  const sessionId = row.entity_id;
  const p = row.payload as {
    fase?: number | null;
    progresso?: number | null;
    erro_codigo?: number | null;
    value?: { history?: Array<{ threads?: Thread[] }> } | null;
  };

  // LGPD (ruling P14): o pedaço cru tem até 180 dias de conversa e `event_log`
  // não entra em retenção nem na cascata de redact. Tratado, o dado sai da fila
  // — também quando a sessão já não existe, que é quando ninguém mais o lerá.
  const limparBruto = async () => {
    const { error } = await admin
      .from("event_log")
      .update({ payload: { ...row.payload, value: null, limpo_em: new Date().toISOString() } })
      .eq("organization_id", orgId)
      .eq("id", row.id);
    if (error) logger.warn("[meta.history] bruto não limpo", { organization_id: orgId, event: row.id, reason: error.message });
  };

  if (!sessionId) {
    await limparBruto();
    return resultado("skipped", "sem_sessao");
  }
  const { data: sessao, error: erroSessao } = await admin
    .from("channel_sessions")
    .select("id, phone_number, metadata, archived_at")
    .eq("organization_id", orgId)
    .eq("id", sessionId)
    .maybeSingle();
  // Única falha que devolve `error` (o drain repete): sem a sessão não há como
  // saber de que lado está cada mensagem.
  if (erroSessao) return resultado("error", `sessao: ${erroSessao.message}`);
  if (!sessao || (sessao as { archived_at?: string | null }).archived_at) {
    await limparBruto();
    return resultado("skipped", sessao ? "sessao_arquivada" : "sessao_ausente");
  }
  const numeroDoNegocio = (sessao as { phone_number: string | null }).phone_number;
  const agora = Date.now();

  let gravadas = 0;
  let duplicadas = 0;
  let falhas = 0;
  const threads = (Array.isArray(p.value?.history) ? p.value.history : []).flatMap((h) =>
    Array.isArray(h?.threads) ? h.threads : [],
  );
  for (const thread of threads) {
    const chatId = digitos(thread.id);
    if (!chatId || String(thread.id ?? "").endsWith("@g.us")) continue; // grupo: fora do CRM, como no inbound
    const alvo = await resolverContatoEConversa(admin, orgId, sessionId, chatId, null);
    if (!alvo.ok) {
      falhas += 1;
      logger.warn("[meta.history] thread pulada", { organization_id: orgId, session: sessionId, reason: alvo.reason });
      continue;
    }
    const { contactId, conversationId } = alvo;

    let maisNova: { at: string; preview: string } | null = null;
    for (const m of Array.isArray(thread.messages) ? thread.messages : []) {
      if (!m?.id) continue;
      const outbound = mesmoNumero(m.from, numeroDoNegocio);
      const sentAt = new Date(Number(m.timestamp ?? "0") * 1000).toISOString();
      const tipoDaMeta = m.type ?? "unknown";
      const { type, bodyDeSistema } = tipoDoCrm(tipoDaMeta);
      const midia = tipoDaMeta !== "text" ? (m[tipoDaMeta] as { id?: string; mime_type?: string } | undefined) : undefined;
      const midiaId = typeof midia?.id === "string" ? midia.id : null;
      const midiaRecente = midiaId !== null && agora - Date.parse(sentAt) <= JANELA_DE_MIDIA_MS;
      const body = bodyDeSistema ?? (tipoDaMeta === "text" ? (m.text?.body ?? null) : null);

      const { data: inserida, error } = await admin
        .from("messages")
        .insert({
          organization_id: orgId,
          conversation_id: conversationId,
          channel_session_id: sessionId,
          contact_id: contactId,
          direction: outbound ? "outbound" : "inbound",
          status: outbound ? "sent" : "delivered",
          ...(outbound ? { sent_via: "external_device" } : {}),
          type,
          body,
          external_id: m.id,
          media_url: midiaRecente ? `meta-media:${midiaId}` : null,
          media_mime: midia?.mime_type ?? null,
          sent_at: sentAt,
          metadata: {
            importada_do_historico: true,
            origem: outbound ? "celular" : "contato",
            tipo_da_meta: tipoDaMeta,
            ...(midiaRecente ? { meta_media_id: midiaId } : midiaId ? { midia_indisponivel: true } : {}),
          },
        })
        .select("id")
        .maybeSingle();
      if (error) {
        if (error.code === "23505") {
          duplicadas += 1;
          continue;
        }
        falhas += 1;
        logger.warn("[meta.history] mensagem pulada", {
          organization_id: orgId, session: sessionId, external_id: m.id, code: error.code, reason: error.message,
        });
        continue;
      }
      gravadas += 1;
      if (!maisNova || sentAt > maisNova.at) maisNova = { at: sentAt, preview: (body ?? `[${type}]`).slice(0, 120) };
      const messageId = (inserida as { id: string } | null)?.id;
      if (midiaRecente && messageId) await pedirPersistenciaDeMidia(admin, orgId, messageId, conversationId, "meta_history");
    }
    // Só a ordenação/prévia da lista, e só se o histórico for mais novo que o que já há.
    // NÃO passa por fn_mark_conversation_message (last_inbound_at, não-lidas).
    if (maisNova) await atualizarPreviaSeMaisNova(admin, orgId, conversationId, maisNova);
  }

  const coex = lerCoexistencia((sessao as { metadata?: unknown }).metadata);
  if (coex) {
    const erro_codigo = p.erro_codigo ?? coex.historico?.erro_codigo ?? null;
    await gravarCoexistencia(admin, orgId, sessionId, {
      ...coex,
      historico: { fase: p.fase ?? null, progresso: p.progresso ?? null, concluido: (p.progresso ?? 0) >= 100, erro_codigo },
    });
  }

  await limparBruto();
  logger.info("[meta.history] chunk processado", {
    organization_id: orgId, session: sessionId, gravadas, duplicadas, falhas, fase: p.fase, progresso: p.progresso,
  });
  return resultado("ok", `gravadas=${gravadas} duplicadas=${duplicadas} falhas=${falhas}`);
}

async function atualizarPreviaSeMaisNova(
  admin: SupabaseClient,
  orgId: string,
  conversationId: string,
  nova: { at: string; preview: string },
): Promise<void> {
  const { data } = await admin
    .from("conversations")
    .select("last_message_at")
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .maybeSingle();
  const atual = (data as { last_message_at: string | null } | null)?.last_message_at;
  if (atual && Date.parse(atual) >= Date.parse(nova.at)) return;
  await admin
    .from("conversations")
    .update({ last_message_at: nova.at, last_message_preview: nova.preview })
    .eq("organization_id", orgId)
    .eq("id", conversationId);
}
