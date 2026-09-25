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
 * mesmo jeito que `ingestMetaInbound` faz, e o worker segue o MESMO caminho da
 * mídia do WhatsApp: pede o adapter pela sessão e chama `fetchInboundMedia`
 * (`lib/channels/adapters/instagram.ts`), que baixa por allowlist de host
 * (`*.cdninstagram.com` / `*.fbcdn.net` / `*.fbsbx.com`) e grava em
 * `whatsapp-media` — download §5.4, não envio (isso é §5.5, que continua fora
 * desta etapa). Sem o adapter implementado a URL do CDN expiraria antes de
 * qualquer reprocessamento tardio; com ele, a persistência acontece no mesmo
 * ciclo do evento, como no WhatsApp oficial.
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

  // Perfil (Graph + decrypt do token) só na PRIMEIRA vez, não em toda mensagem.
  // `fn_upsert_contato_por_identidade` já atualiza a identidade existente sem
  // pedir nome de novo — chamar a Graph de qualquer forma custava 1 request por
  // mensagem (e por reentrega da Meta, que chega ANTES do dedup de `external_id`
  // no insert) contra o rate limit por conta do Instagram, de graça: o nome já
  // estava gravado desde a primeira mensagem desta pessoa.
  let perfil = { nome: null as string | null, handle: null as string | null, foto: null as string | null };
  if (!e.eco && sessao.tokenCifrado) {
    const { data: identidade } = await admin
      .from("contact_channel_identities")
      .select("contact_id")
      .eq("organization_id", orgId)
      .eq("channel", "instagram")
      .eq("external_id", pessoa)
      .maybeSingle();
    if (!identidade) {
      const token = await decryptWebhookSecret(admin, sessao.tokenCifrado);
      if (token) perfil = await perfilDoRemetente(token, pessoa);
    }
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
    const { error: erroOrigem } = await admin.from("contacts")
      .update({ custom_fields: { ...camposAtuais, [sessao.origemPadrao.campo]: sessao.origemPadrao.valor } })
      .eq("id", contato.contact_id)
      .eq("organization_id", orgId);
    if (erroOrigem) {
      // Sem log aqui a origem padrão fica faltando em silêncio: nenhum erro
      // sobe (a ingestão segue — a mensagem não pode falhar por causa disto),
      // mas também nada avisa que o contato novo nasceu sem a origem que a
      // sessão configurou. Sem PII: só os dois ids e a mensagem do banco.
      logger.warn("[instagram.ingest] atualização da origem padrão falhou", {
        organization_id: orgId,
        contact_id: contato.contact_id,
        detail: erroOrigem.message,
      });
    }
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc("fn_upsert_conversa_de_canal" as never, {
    p_org: orgId, p_contact: contato.contact_id, p_session: sessao.id, p_canal: "instagram",
  } as never);
  if (erroConversa || !conversationId) return { status: "falhou", motivo: `conversa: ${erroConversa?.message ?? "sem id"}` };

  // O envio endereça o cliente pelo IGSID, que é por perfil conectado: fica na
  // CONVERSA (migration 0278), não só na identidade do contato. Só preenche
  // vazio. Falha aqui não derruba a mensagem; o envio recusa com
  // `instagram_sem_destinatario` e o log diz por quê.
  const { error: erroDestinatario } = await admin
    .from("conversations")
    .update({ provider_conversation_id: pessoa })
    .eq("organization_id", orgId)
    .eq("id", conversationId as string)
    .is("provider_conversation_id", null);
  if (erroDestinatario) {
    logger.warn("[instagram.ingest] gravar o destinatário na conversa falhou", {
      organization_id: orgId,
      conversation_id: conversationId as string,
      detail: erroDestinatario.message,
    });
  }

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
    // O eco é o que a conta escreveu no APP do Instagram (a etapa 1 não envia
    // pelo CRM): mesma marca do `fromMe` de outro aparelho no WAHA. Sem ela a
    // linha herdava `sent_via='crm'` e contava como resposta dada no CRM.
    ...(e.eco ? { sent_via: "external_device" } : {}),
    metadata: { canal: "instagram", ...(e.eco ? { eco_do_app: true, fromMe: true } : {}) },
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
