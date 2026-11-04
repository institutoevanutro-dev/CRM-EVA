/**
 * Exames do WhatsApp → Prontuário: a regra do BALÃO, sem import de servidor.
 *
 * O botão "Enviar ao prontuário" aparece numa mensagem recebida com PDF, JPEG
 * ou PNG de até 10 MiB, recebida nos últimos 60 dias e já guardada no CRM.
 * WebP/HEIC aparecem na lista do Prontuário, mas ele recusa sem baixar: no
 * balão viram dica. A mesma janela vale na checagem do servidor
 * (`app/api/v1/messages/[id]/prontuario/route.ts`) e na lista que o Prontuário
 * lê (`lib/prontuario/midias.ts`).
 *
 * O formato é decidido pelo MIME normalizado, nunca pelo `type`: JPEG e HEIC
 * mandados "como documento" chegam com `type = 'document'`.
 */
import type { Message } from "@/lib/types/messaging";

/** O que o Prontuário guarda. */
export const MIMES_ACEITOS = ["application/pdf", "image/jpeg", "image/png"] as const;
/** O que o Prontuário lista mas recusa: no balão, só a dica. */
export const MIMES_SO_DICA = ["image/webp", "image/heic"] as const;
/** O corte do Prontuário (`> 10 * 1024 * 1024` recusa). */
export const LIMITE_DO_PRONTUARIO_BYTES = 10 * 1024 * 1024;
/** O teto da rota de arquivo do CRM. */
export const LIMITE_DA_ROTA_BYTES = 15 * 1024 * 1024;
/** O Prontuário lista sempre `dias=60` (decisão do dono, 04/11). Uma constante só. */
export const JANELA_DO_PRONTUARIO_DIAS = 60;
const JANELA_MS = JANELA_DO_PRONTUARIO_DIAS * 24 * 60 * 60 * 1000;

/** `image/jpeg; charset=binary` → `image/jpeg`. Mesma conta do SQL de `midias.ts`. */
export function mimeNormalizado(mime: string | null | undefined): string {
  return ((mime ?? "").split(";")[0] ?? "").trim().toLowerCase();
}

export function dentroDaJanela(sentAt: string, agora: number): boolean {
  const t = Date.parse(sentAt);
  return Number.isFinite(t) && t >= agora - JANELA_MS;
}

export type SituacaoDoExame = "botao" | "formato" | "grande" | "falhou";

export function situacaoDoExame(m: Message, agora: number): SituacaoDoExame | null {
  if (m.direction !== "inbound") return null;
  if (m.type !== "image" && m.type !== "document") return null;
  if (m.revoked_at) return null;
  if (!dentroDaJanela(m.sent_at, agora)) return null;
  const mime = mimeNormalizado(m.media_mime);
  const aceito = (MIMES_ACEITOS as readonly string[]).includes(mime);
  const dica = (MIMES_SO_DICA as readonly string[]).includes(mime);
  if (!aceito && !dica) return null;
  if (!m.media_storage_path) {
    return aceito && m.metadata?.media_status === "failed" ? "falhou" : null;
  }
  // Sem tamanho a lista do Prontuário não traz o item (mesma regra do SQL).
  if (m.media_size_bytes == null) return null;
  if (dica) return "formato";
  if (m.media_size_bytes > LIMITE_DO_PRONTUARIO_BYTES) return "grande";
  return "botao";
}
