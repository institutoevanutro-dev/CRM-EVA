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
  entry: z.array(z.object({ id: z.string(), messaging: z.array(z.unknown()).optional() }).passthrough()),
});

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
