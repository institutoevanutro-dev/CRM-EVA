/**
 * Payload do webhook do Instagram (object "instagram", entry[].messaging[]).
 * Função pura: nada de banco. Reação, leitura, apagada e objeto de outro produto
 * viram lista vazia; a rota responde 200 do mesmo jeito (a Meta não deve reenviar).
 */
import { z } from "zod";

const anexoSchema = z.object({ type: z.string(), payload: z.object({ url: z.string().url() }).partial().optional() }).passthrough();
const itemSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z.object({
    mid: z.string(),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
    attachments: z.array(anexoSchema).optional(),
  }).passthrough().optional(),
}).passthrough();
const corpoSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(z.object({
    id: z.string(),
    time: z.number().optional(),
    messaging: z.array(z.unknown()).optional(),
    changes: z.array(z.unknown()).optional(),
  }).passthrough()),
});

const comentarioSchema = z.object({
  field: z.string(),
  value: z.object({
    id: z.string(),
    text: z.string().optional(),
    media: z.object({ id: z.string() }).passthrough(),
    from: z.object({ id: z.string(), username: z.string().optional() }).passthrough(),
    timestamp: z.string().optional(),
  }).passthrough(),
}).passthrough();

export interface EventoDoInstagram {
  igAccountId: string;
  remetente: string;
  destinatario: string;
  externalId: string;
  eco: boolean;
  texto: string | null;
  anexos: { tipo: "image" | "video" | "audio" | "file"; url: string }[];
  enviadaEm: Date;
}

const TIPOS = new Set(["image", "video", "audio", "file"]);

export function parseWebhookDoInstagram(corpo: unknown): EventoDoInstagram[] {
  const lido = corpoSchema.safeParse(corpo);
  if (!lido.success) return [];
  const eventos: EventoDoInstagram[] = [];
  for (const entrada of lido.data.entry) {
    for (const bruto of entrada.messaging ?? []) {
      const item = itemSchema.safeParse(bruto);
      if (!item.success || !item.data.message || item.data.message.is_deleted) continue;
      const m = item.data.message;
      const anexos = (m.attachments ?? [])
        .filter((a) => TIPOS.has(a.type) && a.payload?.url)
        .map((a) => ({ tipo: a.type as EventoDoInstagram["anexos"][number]["tipo"], url: a.payload!.url! }));
      const texto = m.text?.trim() ? m.text : null;
      if (!texto && anexos.length === 0) continue;
      eventos.push({
        igAccountId: entrada.id,
        remetente: item.data.sender.id,
        destinatario: item.data.recipient.id,
        externalId: m.mid,
        eco: m.is_echo === true,
        texto,
        anexos,
        enviadaEm: new Date(item.data.timestamp),
      });
    }
  }
  return eventos;
}

export interface ComentarioDoInstagram {
  igAccountId: string;
  externalId: string;
  mediaId: string;
  texto: string | null;
  autorIgsid: string;
  autorHandle: string | null;
  comentadoEm: Date;
  eco: boolean;
}

export function parseComentariosDoInstagram(corpo: unknown): ComentarioDoInstagram[] {
  const lido = corpoSchema.safeParse(corpo);
  if (!lido.success) return [];
  const comentarios: ComentarioDoInstagram[] = [];
  for (const entrada of lido.data.entry) {
    for (const bruto of entrada.changes ?? []) {
      const mudanca = comentarioSchema.safeParse(bruto);
      if (!mudanca.success || mudanca.data.field !== "comments") continue;
      const v = mudanca.data.value;
      // value.timestamp não é documentado pela Meta para "comments" (só entry.time é).
      // Cadeia de fallback pra nunca descartar o comentário por falta de data:
      // ISO de value.timestamp (se vier) > entry.time em SEGUNDOS (se vier) > relógio.
      const comentadoEm = v.timestamp !== undefined
        ? new Date(v.timestamp)
        : entrada.time !== undefined
          ? new Date(entrada.time * 1000)
          : new Date();
      comentarios.push({
        igAccountId: entrada.id,
        externalId: v.id,
        mediaId: v.media.id,
        texto: v.text ?? null,
        autorIgsid: v.from.id,
        autorHandle: v.from.username ?? null,
        comentadoEm,
        eco: v.from.id === entrada.id,
      });
    }
  }
  return comentarios;
}
