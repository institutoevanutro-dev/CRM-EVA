/**
 * AS IMAGENS DA RESPOSTA RÁPIDA vêm da Biblioteca de mídia.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica):
 * lá a resposta guardava arquivos próprios; aqui ela guarda só os ids dos itens
 * da biblioteca (`message_templates.media_item_ids`, migration 0383), e o envio
 * de cada imagem é o envio de item da biblioteca que agentes e acompanhamentos
 * já usam (`media_library_item_id` em `POST /api/v1/messages`), com o termo de
 * uso de imagem conferido ali. O banco garante que o item é da mesma
 * organização e que não é apagado enquanto alguma resposta o usa.
 */
import { z } from "zod";

/** O mesmo teto do CHECK `message_templates_media_item_ids_maxima` (0383). */
export const MAXIMO_DE_MIDIAS = 5;

/** A lista que entra pela API: uuids, sem repetição, na ordem em que saem. */
export const idsDeMidiaSchema = z
  .array(z.string().uuid())
  .max(MAXIMO_DE_MIDIAS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Imagem repetida." });
