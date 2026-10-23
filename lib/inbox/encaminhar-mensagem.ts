/**
 * ENCAMINHAR UMA MENSAGEM — o gesto do botão "Encaminhar" da bolha.
 *
 * ─── O que este arquivo NÃO faz ─────────────────────────────────────────────
 *
 * Não abre um segundo caminho de envio. O envio do Inbox já tem dono, e é
 * `sendMessageHandler` (o mesmo de `POST /api/v1/messages`). Um segundo caminho
 * divergiria do primeiro no dia em que um dos dois ganhasse uma guarda (janela
 * de 24h, canal arquivado, assinatura do emissor), e a mensagem sairia por um
 * lugar onde a regra não vale.
 *
 * Encaminhar é LER a mensagem de origem e MANDAR o conteúdo pelo MESMO caminho,
 * com a conversa de destino no lugar da atual. É essa reutilização que faz o
 * encaminhamento herdar todas as guardas do envio normal — inclusive a marca de
 * `failed`/`queued` quando o canal do destino não pode enviar.
 *
 * A mídia vai pelo objeto do nosso Storage, copiado para a pasta do destino
 * (`lib/inbox/midia-do-encaminhamento.ts`).
 *
 * Portado do projeto original (DeskcommCRM, PR #2841). Lá o encaminhamento
 * também assume a conversa do destino quando a empresa liga "a conversa fica
 * com quem atendeu"; o fork não tem essa regra, nem no envio normal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import {
  resolverMidiaDoEncaminhamento,
  type MidiaParaEncaminhar,
} from "@/lib/inbox/midia-do-encaminhamento";
import { traduzir } from "@/lib/i18n/dicionario";
import type { SendMessageInput } from "@/lib/schemas";
import type { Message } from "@/lib/types/messaging";

type SB = SupabaseClient;

/** As colunas da mensagem de origem que o encaminhamento de fato lê. */
const COLUNAS_DA_ORIGEM =
  "id, organization_id, conversation_id, type, body, media_url, media_storage_path, media_mime, revoked_at";

const TIPOS_DE_MIDIA = new Set(["image", "audio", "video", "document", "sticker"]);

export interface MensagemDeOrigem {
  id: string;
  organization_id: string;
  conversation_id: string;
  type: string | null;
  body: string | null;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  revoked_at: string | null;
}

export interface EncaminharParams {
  /** A mensagem do chat que será encaminhada. */
  messageId: string;
  /** A conversa de destino — existente e acessível à organização. */
  conversationIdDestino: string;
}

/**
 * O motivo pelo qual esta origem NÃO pode ser encaminhada. Um CÓDIGO, e não a
 * frase: a frase sai em `mensagemDoMotivo`, um literal por ramo, para o
 * `traduzir` receber texto que o código escreveu.
 */
export type MotivoNaoEncaminhavel =
  | "apagada"
  | "midia_aguardando"
  | "midia_falhou"
  | "midia_indisponivel"
  | "sem_conteudo";

export function motivoParaNaoEncaminhar(origem: MensagemDeOrigem): MotivoNaoEncaminhavel | null {
  if (origem.revoked_at) return "apagada";
  // Sem texto e sem mídia NENHUMA: não há o que transportar.
  if (!origem.body && !origem.media_url && !origem.media_storage_path) return "sem_conteudo";
  return null;
}

export function mensagemDoMotivo(motivo: MotivoNaoEncaminhavel, t: (texto: string) => string): string {
  switch (motivo) {
    case "apagada":
      return t("Esta mensagem foi apagada e não pode ser encaminhada.");
    case "midia_aguardando":
      return t("A mídia desta mensagem ainda não chegou ao CRM. Tente encaminhar de novo em alguns segundos.");
    case "midia_falhou":
      return t("Não consegui preparar a mídia desta mensagem para o encaminhamento. Tente de novo em instantes.");
    // Sem "tente de novo": esta mídia nunca vai poder ser copiada (a proposta em
    // PDF, que mora fora da pasta da conversa; a mídia que a retenção apagou).
    case "midia_indisponivel":
      return t("Esta mídia não pode ser encaminhada.");
    case "sem_conteudo":
      return t("Só é possível encaminhar mensagens de texto ou mídia.");
  }
}

/**
 * O `input` do envio, montado a partir da mensagem de origem: o destino é só a
 * `conversation_id` trocada. A origem fica em `metadata`, para a conversa de
 * destino guardar de onde a mensagem veio sem inventar coluna.
 */
export function montarEntradaDeEncaminhamento(
  origem: MensagemDeOrigem,
  conversationIdDestino: string,
  midia: MidiaParaEncaminhar,
): SendMessageInput {
  const entrada: SendMessageInput = {
    conversation_id: conversationIdDestino,
    // Com mídia, o tipo é o da origem (image/video/…), que vem do NOSSO banco;
    // só texto é `text`. O cast acomoda o literal que `SendMessageInput` exige.
    type: (midia.tipo === "copia" ? (origem.type ?? "text") : "text") as SendMessageInput["type"],
    metadata: {
      forwarded_from_message_id: origem.id,
      forwarded_from_conversation_id: origem.conversation_id,
    },
  };
  if (origem.body) entrada.body = origem.body;
  if (midia.tipo === "copia") {
    entrada.media_storage_path = midia.media_storage_path;
    if (midia.media_mime) entrada.media_mime = midia.media_mime;
  }
  return entrada;
}

/** Lê a mensagem de origem DA ORGANIZAÇÃO: o filtro é o que separa os tenants. */
async function lerOrigem(supabase: SB, ctx: HandlerCtx, messageId: string): Promise<MensagemDeOrigem> {
  const { data, error } = await supabase
    .from("messages")
    .select(COLUNAS_DA_ORIGEM)
    .eq("id", messageId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, traduzir("Mensagem não encontrada.", ctx.idioma ?? "pt-BR"));
  }
  return data as unknown as MensagemDeOrigem;
}

/**
 * O destino tem de ser uma conversa DESTA organização, e isso é conferido ANTES
 * de copiar qualquer objeto: o id vem do corpo do pedido, e a cópia usa service
 * role. O canal do destino (arquivado, desconectado) quem confere é o envio.
 */
async function validarDestino(supabase: SB, ctx: HandlerCtx, conversationIdDestino: string): Promise<void> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationIdDestino)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  if (!data) {
    throw new ApiError(
      422,
      "destino_invalido",
      undefined,
      ctx.requestId,
      traduzir("Escolha uma conversa de destino desta organização.", ctx.idioma ?? "pt-BR"),
    );
  }
}

/**
 * Encaminha a mensagem `messageId` para a conversa `conversationIdDestino`, pelo
 * MESMO caminho de envio do Inbox. Devolve a linha criada no destino; a origem
 * só é LIDA (o objeto no Storage é COPIADO, o original fica onde está).
 */
export async function encaminharMensagem(supabase: SB, ctx: HandlerCtx, params: EncaminharParams): Promise<Message> {
  const t = (texto: string) => traduzir(texto, ctx.idioma ?? "pt-BR");
  const recusar = (motivo: MotivoNaoEncaminhavel) =>
    new ApiError(422, "nao_encaminhavel", undefined, ctx.requestId, mensagemDoMotivo(motivo, t));

  const origem = await lerOrigem(supabase, ctx, params.messageId);
  const motivo = motivoParaNaoEncaminhar(origem);
  if (motivo) throw recusar(motivo);

  await validarDestino(supabase, ctx, params.conversationIdDestino);

  const midia = await resolverMidiaDoEncaminhamento(origem, params.conversationIdDestino);
  if (midia.tipo === "aguardando") throw recusar("midia_aguardando");
  if (midia.tipo === "falhou") throw recusar("midia_falhou");
  // Mídia sem objeto e sem endereço (a retenção apagou, ou é item da biblioteca):
  // mandar só a legenda diria "encaminhada" para uma imagem que não foi.
  if (midia.tipo === "fora_da_conversa" || (midia.tipo === "sem_midia" && TIPOS_DE_MIDIA.has(origem.type ?? ""))) {
    throw recusar("midia_indisponivel");
  }

  return sendMessageHandler(supabase, ctx, montarEntradaDeEncaminhamento(origem, params.conversationIdDestino, midia));
}
