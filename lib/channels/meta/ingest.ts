/**
 * Ingestão de mensagem RECEBIDA pelo canal oficial — a metade que faltava.
 *
 * Sem ela o canal é um megafone: o cliente responde e nada chega, nenhum lead se
 * move, o agente não acorda, e a janela de 24h — que deriva de
 * `conversations.last_inbound_at` — nunca abre. O gate da Fase 4 vetaria para sempre
 * e o sistema só saberia falar por template.
 *
 * ─── Reusa as MESMAS operações canônicas do outro canal ─────────────────────
 * `fn_upsert_wa_contact` / `fn_upsert_wa_conversation` / `fn_mark_conversation_message`
 * já resolvem contato e conversa de forma atômica, e são agnósticas de provider. O
 * que muda aqui é só o mapeamento do payload — escrever uma segunda resolução de
 * contato seria criar a divergência que a migration 0027 (wa_identity canônica)
 * eliminou.
 *
 * ─── Duas armadilhas medidas contra a WABA real ─────────────────────────────
 * 1. **O `wa_id` pode vir sem o nono dígito** (`553198966398` para quem recebemos
 *    como `5531998966398`). A resolução do contato passa por `phoneLookupVariants`,
 *    senão a mesma pessoa vira dois cadastros e a conversa parte ao meio.
 * 2. **A Meta re-entrega tudo que não recebe 2xx.** A idempotência por
 *    `unique (organization_id, external_id)` não é higiene, é obrigatória: sem ela a
 *    mesma mensagem aparece N vezes no inbox depois de qualquer instabilidade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { logger } from "@/lib/logger";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { extrairAtribuicaoMeta } from "../atribuicao-de-anuncio-oficial";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { canonicalPhoneBR } from "../phone-variants";
import type { ChannelTenantScope } from "../types";
import type { EchoMessageEvent, InboundMessageEvent } from "./webhook";

type Admin = SupabaseClient;

export type IngestOutcome =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "no_session" }
  | { status: "failed"; reason: string };

/**
 * Sessão dona do número que RECEBEU, **dentro da organização do token**.
 *
 * O cabeçalho anterior já dizia "nunca confiamos no corpo para escolher
 * organização" — e a consulta fazia exatamente isso: `phoneNumberId` sai do
 * corpo do webhook e era o ÚNICO filtro. Duas organizações com o mesmo número
 * (configuração legítima: agência, migração entre organizações) faziam
 * `maybeSingle()` casar duas linhas, devolver `data: null` com `PGRST116` — e,
 * com o `error` descartado, a mensagem que acabou de chegar era descartada para
 * as DUAS, com a rota respondendo 200 (issue #236).
 *
 * A organização vem de `dono`, resolvido pela rota a partir do TOKEN DO PATH
 * (`metaSessionByWebhookToken`) — a mesma fonte confiável que já decide onde o
 * status de template e o status de mensagem são gravados nesse handler. O
 * número continua no filtro porque uma organização pode ter mais de um número
 * oficial, e é ele que diz QUAL sessão recebeu.
 *
 * Sessão ARQUIVADA não é dona de nada: o usuário excluiu o canal. Sem este
 * filtro, o desfecho `no_session` (que o chamador loga e devolve no corpo) vira
 * uma mensagem gravada num canal que já não existe para o operador.
 *
 * **LANÇA quando a consulta falha**, para o chamador gravar `failed` com o
 * motivo em vez de `no_session`. "Não achei" e "não consegui perguntar" pedem
 * ações diferentes do operador, e colapsá-los foi metade do defeito.
 */
async function sessionByPhoneNumberId(
  admin: Admin,
  organizationId: string,
  phoneNumberId: string,
) {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id")
      .eq("organization_id", organizationId)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `sessao_do_numero: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }
  return data;
}

/**
 * Contato já existente sob QUALQUER variante do número. Só depois de não achar é que
 * deixamos o upsert criar — assim o cadastro nasce uma vez só.
 */
/**
 * Delega para `encontrarContatoPorTelefone`, que decide QUAL grafia vence.
 *
 * Era uma cópia local com `.in(variantes).limit(1)` — sem `order by`, e sem o
 * filtro de contato fundido. Três funções idênticas viviam assim no repo; a
 * regra agora mora num lugar só.
 */
async function findContactByVariants(
  admin: Admin,
  orgId: string,
  waId: string,
): Promise<{ id: string; phone_number: string } | null> {
  return encontrarContatoPorTelefone(admin as never, orgId, waId);
}

/**
 * Contato por variantes do número → `canonicalPhoneBR` → `fn_upsert_wa_contact`
 * → `fn_upsert_wa_conversation`. ÚNICA cópia (ruling P12): inbound, eco do
 * celular e histórico passam aqui — três resoluções divergiriam na primeira vez
 * que alguém mexesse numa só.
 *
 * `waId` é o OUTRO lado da conversa (remetente no inbound, destinatário no eco).
 * `notify` é o nome de perfil dele quando o payload o traz; `null` quando o
 * nome no payload seria o da própria loja.
 *
 * `historico`: a conversa que ainda não existe nasce ENCERRADA
 * (`fn_upsert_wa_conversation_do_historico`, migration 0297), fora da fila de
 * roteamento; a que já existe fica como está.
 */
export async function resolverContatoEConversa(
  admin: Admin,
  orgId: string,
  sessaoId: string,
  waId: string,
  notify: string | null,
  opcoes: { historico?: boolean } = {},
): Promise<{ ok: true; contactId: string; conversationId: string } | { ok: false; reason: string }> {
  const existente = await findContactByVariants(admin, orgId, waId);
  // Celular BR grava COM o nono. A busca acima já reencontra a grafia sem o 9;
  // a RPC promove o cadastro antigo quando ainda está nos 12 dígitos.
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : canonicalPhoneBR(`+${waId.replace(/\D/g, "")}`);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    { p_org: orgId, p_kind: "phone", p_phone: phone, p_lid: null, p_chat_id: waId, p_notify: notify } as never,
  );
  if (erroContato || !contactId) {
    return { ok: false, reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    (opcoes.historico ? "fn_upsert_wa_conversation_do_historico" : "fn_upsert_wa_conversation") as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessaoId } as never,
  );
  if (erroConversa || !conversationId) {
    return { ok: false, reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }
  return { ok: true, contactId: contactId as string, conversationId: conversationId as string };
}

/**
 * Vocabulário de `messages_type_check` (baseline, bloco
 * `message type: template (migration 0091)`).
 */
export const TIPOS_DO_CRM: ReadonlySet<string> = new Set([
  "text", "image", "video", "audio", "document", "sticker", "location", "contact", "reaction", "system", "template",
]);

/**
 * Tipo cru da Meta → valor aceito por `messages_type_check` (ruling P4).
 * `contacts` (plural da Meta) → `contact`; o que não tem equivalente vira
 * `system` com body `[tipo]` — um tipo exótico nunca derruba o INSERT.
 */
export function tipoDoCrm(tipo: string): { type: string; bodyDeSistema: string | null } {
  if (tipo === "contacts") return { type: "contact", bodyDeSistema: null };
  if (TIPOS_DO_CRM.has(tipo)) return { type: tipo, bodyDeSistema: null };
  return { type: "system", bodyDeSistema: `[${tipo || "unknown"}]` };
}

/**
 * Pede ao worker de mídia que baixe o arquivo da Graph e o grave no Storage.
 * Falha aqui não derruba a ingestão (a mensagem já entrou); vai ao log.
 */
export async function pedirPersistenciaDeMidia(
  admin: Admin,
  orgId: string,
  messageId: string,
  conversationId: string,
  source: string,
): Promise<void> {
  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "media.persist_requested",
    p_entity_kind: "message",
    p_entity_id: messageId,
    p_payload: { message_id: messageId, conversation_id: conversationId },
    p_metadata: { source },
    p_organization_id: orgId,
  } as never);
  if (error) {
    logger.error("[meta.ingest] emit media.persist_requested failed", {
      organization_id: orgId,
      message_id: messageId,
      erro: error.message,
    });
  }
}

/** Prévia curta para a lista de conversas. Mídia vira rótulo, nunca URL. */
function previewOf(
  e: Pick<InboundMessageEvent, "type" | "text" | "media"> & Partial<Pick<InboundMessageEvent, "sharedContact">>,
): string {
  if (e.type === "text") return (e.text ?? "").slice(0, 120);
  if (e.type === "contact") return e.sharedContact?.name ? `👤 ${e.sharedContact.name}` : "[contato]";
  if (e.type === "audio") return e.media?.voice ? "🎤 Mensagem de voz" : "🎵 Áudio";
  if (e.type === "image") return "📷 Imagem";
  if (e.type === "video") return "🎬 Vídeo";
  if (e.type === "document") return "📎 Documento";
  return `[${e.type}]`;
}

export async function ingestMetaInbound(
  admin: Admin,
  e: InboundMessageEvent,
  dono: ChannelTenantScope,
): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try {
    sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  } catch (err) {
    // Falhar FECHADO na ação (nada é gravado) e ABERTO na informação: o motivo
    // sobe como `failed` e o chamador o escreve no log e no corpo.
    return { status: "failed", reason: err instanceof Error ? err.message : "sessao_do_numero" };
  }
  // Sem sessão: a mensagem é de um número que não administramos. Devolver 200 (o
  // chamador faz isso) evita a Meta re-entregar em loop algo que nunca vamos aceitar.
  if (!sessao) return { status: "no_session" };

  const orgId = sessao.organization_id;

  const alvo = await resolverContatoEConversa(admin, orgId, sessao.id, e.from, e.profileName);
  if (!alvo.ok) return { status: "failed", reason: alvo.reason };
  const { contactId, conversationId } = alvo;

  // Clique em anúncio: o `referral` vem na própria mensagem e só nela. Estampar
  // AQUI, antes de `aplicarEfeitosPosEntrada`, porque é lá que o lead nasce. A
  // guarda de primeiro toque fica no banco, então a re-entrega não reescreve.
  const atribuicao = extrairAtribuicaoMeta(e.referral);
  if (atribuicao) await estamparAtribuicaoDoContato(admin, contactId, atribuicao);

  // Tipo fora do CHECK (`interactive`, `button`, …) derrubava o INSERT — e a
  // mensagem do cliente sumia. Passa pelo mesmo mapa do eco e do histórico.
  const { type, bodyDeSistema } = tipoDoCrm(e.type);
  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId,
      // NOT NULL na tabela. Esquecê-lo fez o insert falhar e — porque a rota
      // descartava o resultado — a falha virou "recebido: 1" com nada gravado.
      channel_session_id: sessao.id,
      contact_id: contactId,
      direction: "inbound",
      status: "delivered",
      type,
      body: bodyDeSistema ?? (type === "contact" ? (e.sharedContact?.name ?? e.text) : e.text),
      external_id: e.externalId,
      // O webhook oficial entrega o media_id, não um arquivo que o browser
      // consiga abrir. Mantemos um ponteiro opaco para o adapter resolver pela
      // Graph API; sem ele a bolha nem é renderizada e o worker pula a mídia.
      media_url: e.media ? `meta-media:${e.media.id}` : null,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: {
        tipo_da_meta: e.type,
        ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}),
        ...(e.sharedContact ? { shared_contact: e.sharedContact } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  // 23505 = a mesma `external_id` já entrou. Não é erro: é a Meta re-entregando.
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  // Carimba a conversa — é ISTO que move `last_message_at`, `last_inbound_at` e
  // abre a janela de 24h. Falha aqui não derruba a ingestão (a mensagem já
  // entrou), mas a prévia, a ordenação da Inbox e a janela ficariam paradas.
  //
  // ⚠️ O RETORNO ERA IGNORADO, e o comentário que estava aqui afirmava o
  // contrário — "o erro sobe como `failed` parcial no log do chamador em vez de
  // sumir". Sumia: era um `await` sem destino para o `{ error }`. O canal
  // oficial era o pior dos três justamente onde a falha dói mais, porque é ele
  // que tem janela de 24h — e conversa sem carimbo é janela que ninguém vê
  // fechar. Quem decide o que fazer com a falha agora é uma função só.
  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: conversationId,
    direction: "inbound",
    preview: previewOf(e),
    at: e.sentAt.toISOString(),
    canal: "meta",
  });

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (e.media && messageId) {
    await pedirPersistenciaDeMidia(admin, orgId, messageId, conversationId, "meta_webhook");
  }
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: contactId,
    conversationId: conversationId,
    messageId: messageId || null,
    channelSessionId: sessao.id,
    texto: e.text ?? null,
    nomeDoContato: e.profileName ?? null,
    origem: "meta_webhook",
  });

  return {
    status: "ingested",
    messageId,
    conversationId: conversationId,
  };
}

/**
 * Eco do CELULAR (`smb_message_echoes`): uma pessoa respondeu pelo WhatsApp
 * Business do aparelho. É o mesmo gesto do `fromMe` do outro canal
 * (`lib/waha/ingest.ts`, `handleOutboundFromUserPhone`) e tem o mesmo desfecho:
 * linha outbound `external_device` (a bolha a rotula "Celular"), conversa
 * carimbada como saída (zera não-lidas, não toca `last_inbound_at`), IA pausada
 * por `pausarIaPorAtendimentoManual` — a regra de 5 min que o composer também
 * usa. NÃO passa por `aplicarEfeitosPosEntrada`: ninguém entrou, alguém saiu. E
 * o trigger de `messages` só emite `message.received` para inbound
 * (`eco-nao-acorda-a-ia.test.ts`), então nenhum worker de IA/automação acorda.
 *
 * Idempotente por `(organization_id, external_id)`; o `duplicate` não pausa
 * nada — um wamid repetido pode ser reentrega de eco de envio do próprio CRM.
 *
 * PREMISSA (ruling P10, decidida e não provada): a Meta NÃO ecoa em
 * `smb_message_echoes` o que foi enviado pela Cloud API — a documentação de
 * 01/10/2026 ("message echoes") descreve mensagens enviadas pelo APLICATIVO do
 * celular. Por isso o gate do #519 (`ehEcoDeEnvioNosso`: linha `queued` sem
 * `external_id` na mesma conversa) não é generalizado aqui. Se a premissa
 * cair, o sintoma é a IA calada 5 min depois do próprio envio; o teste
 * "linha queued sem external_id não barra o eco" é o que passa a mudar.
 */
export async function ingestMetaEcho(
  admin: Admin,
  e: EchoMessageEvent,
  dono: ChannelTenantScope,
): Promise<IngestOutcome> {
  let sessao: { id: string; organization_id: string } | null;
  try {
    sessao = await sessionByPhoneNumberId(admin, dono.organizationId, e.phoneNumberId);
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : "sessao_do_numero" };
  }
  if (!sessao) return { status: "no_session" };
  const orgId = sessao.organization_id;

  // O contato é o DESTINATÁRIO; sem `notify` (o nome do perfil aqui seria o da loja).
  const alvo = await resolverContatoEConversa(admin, orgId, sessao.id, e.to, null);
  if (!alvo.ok) return { status: "failed", reason: alvo.reason };
  const { contactId, conversationId } = alvo;

  const { type, bodyDeSistema } = tipoDoCrm(e.type);
  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId,
      channel_session_id: sessao.id,
      contact_id: contactId,
      direction: "outbound",
      status: "sent",
      sent_via: "external_device",
      type,
      body: bodyDeSistema ?? e.text,
      external_id: e.externalId,
      media_url: e.media ? `meta-media:${e.media.id}` : null,
      media_mime: e.media?.mime ?? null,
      sent_at: e.sentAt.toISOString(),
      metadata: {
        origem: "celular",
        fromMe: true,
        tipo_da_meta: e.type,
        ...(e.media ? { meta_media_id: e.media.id, voice: e.media.voice } : {}),
      },
    })
    .select("id")
    .maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId,
    direction: "outbound",
    preview: previewOf(e),
    at: e.sentAt.toISOString(),
    canal: "meta",
  });
  await pausarIaPorAtendimentoManual(admin, { organizationId: orgId, conversationId, canal: "meta", agora: e.sentAt });

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  if (e.media && messageId) {
    await pedirPersistenciaDeMidia(admin, orgId, messageId, conversationId, "meta_echo");
  }
  return { status: "ingested", messageId, conversationId };
}
