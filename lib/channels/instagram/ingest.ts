/**
 * Um evento do webhook do Instagram vira contato + conversa + mensagem, pelos mesmos
 * passos do WhatsApp oficial (`../meta/ingest.ts`): marcar a conversa e aplicar os
 * efeitos pós-entrada (opt-out, lead/card, despacho). Eco (a conta respondeu pelo app)
 * entra como outbound e NÃO dispara efeito de entrada.
 *
 * ─── Mídia: URL do CDN direto, sem `meta-media:` ────────────────────────────
 * O WhatsApp oficial guarda `meta-media:<id>` porque o webhook só entrega um id
 * opaco — o worker (`workers/media-persist-worker.ts`) resolve pela Graph API
 * via `adapter.fetchInboundMedia`. O Instagram já entrega a URL do CDN pronta no
 * payload (`parseWebhookDoInstagram`), então ela é gravada direto em `media_url`
 * — não há id para reconstruir depois. `media.persist_requested` é emitido do
 * mesmo jeito que `ingestMetaInbound` faz: o worker é agnóstico de canal (pede o
 * adapter pela sessão) e hoje `instagramAdapter` não implementa
 * `fetchInboundMedia` (etapa 1 só recebe metadado, spec §5.5 trata envio), então
 * o worker apenas pula (`skipped: canal_sem_midia_de_entrada`) — não falha, não
 * reentrega. A URL do CDN expira antes de qualquer reprocessamento tardio: a
 * persistência real de mídia do Instagram é trabalho de uma etapa seguinte, que
 * implementa `fetchInboundMedia` no adapter.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { perfilDoRemetente } from "./graph";
import type { EventoDoInstagram } from "./webhook";

export type ResultadoDaIngestao =
  | { status: "ingerida"; messageId: string; conversationId: string; contatoNovo: boolean }
  | { status: "duplicada" }
  | { status: "sem_sessao" }
  | { status: "falhou"; motivo: string };

export interface SessaoDoInstagram {
  id: string;
  organizationId: string;
  igAccountId: string;
  tokenCifrado: string | null;
  origemPadrao: { campo: string; valor: string } | null;
}

function preview(e: EventoDoInstagram): string {
  if (e.texto) return e.texto.slice(0, 120);
  const tipo = e.anexos[0]?.tipo;
  return tipo === "image" ? "📷 Imagem" : tipo === "video" ? "🎬 Vídeo" : tipo === "audio" ? "🎵 Áudio" : "📎 Arquivo";
}

export async function ingerirDoInstagram(
  admin: SupabaseClient,
  e: EventoDoInstagram,
  sessao: SessaoDoInstagram,
): Promise<ResultadoDaIngestao> {
  const orgId = sessao.organizationId;
  const pessoa = e.eco ? e.destinatario : e.remetente;

  let perfil = { nome: null as string | null, handle: null as string | null, foto: null as string | null };
  if (!e.eco && sessao.tokenCifrado) {
    const token = await decryptWebhookSecret(admin, sessao.tokenCifrado);
    if (token) perfil = await perfilDoRemetente(token, pessoa);
  }

  const { data: linhasContato, error: erroContato } = await admin.rpc("fn_upsert_contato_por_identidade" as never, {
    p_org: orgId, p_canal: "instagram", p_external_id: pessoa,
    p_handle: perfil.handle, p_nome: perfil.nome, p_avatar: perfil.foto,
  } as never);
  const contato = (linhasContato as { contact_id: string; criado: boolean }[] | null)?.[0];
  if (erroContato || !contato) return { status: "falhou", motivo: `contato: ${erroContato?.message ?? "sem id"}` };

  if (contato.criado && sessao.origemPadrao) {
    // Lê e mescla em vez de sobrescrever: o contato acabou de nascer nesta
    // mesma chamada (`custom_fields` deveria ser `{}`), mas uma reentrega do
    // webhook ou uma edição concorrente do Inbox pode ter escrito algo entre a
    // criação e este update — mesclar é barato e evita apagar o que já estava lá.
    const { data: contatoAtual } = await admin
      .from("contacts")
      .select("custom_fields")
      .eq("id", contato.contact_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    const camposAtuais = (contatoAtual as { custom_fields: Record<string, unknown> } | null)?.custom_fields ?? {};
    await admin.from("contacts")
      .update({ custom_fields: { ...camposAtuais, [sessao.origemPadrao.campo]: sessao.origemPadrao.valor } })
      .eq("id", contato.contact_id)
      .eq("organization_id", orgId);
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc("fn_upsert_conversa_de_canal" as never, {
    p_org: orgId, p_contact: contato.contact_id, p_session: sessao.id, p_canal: "instagram",
  } as never);
  if (erroConversa || !conversationId) return { status: "falhou", motivo: `conversa: ${erroConversa?.message ?? "sem id"}` };

  const anexo = e.anexos[0] ?? null;
  const { data: inserida, error: erroInsert } = await admin.from("messages").insert({
    organization_id: orgId,
    conversation_id: conversationId as string,
    channel_session_id: sessao.id,
    contact_id: contato.contact_id,
    direction: e.eco ? "outbound" : "inbound",
    status: e.eco ? "sent" : "delivered",
    type: anexo ? (anexo.tipo === "file" ? "document" : anexo.tipo) : "text",
    body: e.texto,
    external_id: e.externalId,
    media_url: anexo?.url ?? null,
    sent_at: e.enviadaEm.toISOString(),
    metadata: { canal: "instagram", ...(e.eco ? { eco_do_app: true } : {}) },
  }).select("id").maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicada" };
    return { status: "falhou", motivo: `mensagem: ${erroInsert.message}` };
  }
  const messageId = (inserida as { id: string } | null)?.id ?? "";

  await marcarConversaComMensagem(admin, {
    organizationId: orgId, conversationId: conversationId as string,
    direction: e.eco ? "outbound" : "inbound", preview: preview(e),
    at: e.enviadaEm.toISOString(), canal: "instagram",
  });

  if (anexo && messageId) {
    const { error: erroPersistencia } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, conversation_id: conversationId as string },
      p_metadata: { source: "instagram_webhook" },
      p_organization_id: orgId,
    } as never);
    if (erroPersistencia) {
      logger.warn("[instagram.ingest] emit media.persist_requested falhou", {
        message_id: messageId,
        detail: erroPersistencia.message,
      });
    }
  }

  if (!e.eco) {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: orgId, contactId: contato.contact_id, conversationId: conversationId as string,
      messageId: messageId || null, channelSessionId: sessao.id, texto: e.texto,
      nomeDoContato: perfil.nome ?? perfil.handle, origem: "instagram_webhook",
    });
  }
  return { status: "ingerida", messageId, conversationId: conversationId as string, contatoNovo: contato.criado };
}
