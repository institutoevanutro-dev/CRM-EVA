/**
 * Escolhas puras do envio de um item da biblioteca (spec 2026-10-06, fatia 2).
 * Quem lê o banco e confere o termo é o handler de mensagens.
 */
import { pickReentryVariant } from "@/lib/agent-engine/agent/reentry-template";
import type { Variante } from "@/lib/midias/termo";

/** A pedida, se existir; senão sorteio estável por contato (o mesmo da re-entrada). */
export function escolherVariante(variantes: Variante[], contactId: string, pedida?: "A" | "B"): Variante | null {
  if (variantes.length === 0) return null;
  const exata = pedida ? variantes.find((v) => v.key === pedida) : undefined;
  if (exata) return exata;
  const chave = pickReentryVariant(contactId, variantes.map((v) => v.key).sort());
  return variantes.find((v) => v.key === chave) ?? null;
}

export function tipoDaMidia(mime: string): "image" | "video" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}
