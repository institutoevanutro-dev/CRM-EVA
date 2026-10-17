/**
 * Canal fixado no gatilho de consulta (migration 0377): por qual número o
 * acompanhamento sai, em `trigger_config.params.channel_session_id`.
 *
 * O banco (`fn_appointment_recover`) já ignora canal arquivado, de outra
 * organização ou que não é WhatsApp 1:1 e volta ao canal da conversa da
 * consulta. Esta conferência existe para que o operador saiba NA HORA de
 * salvar/publicar, e não descubra semanas depois que a mensagem saiu pelo
 * número da clínica.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Espelho do `s.provider in (...)` de `fn_appointment_recover` (0377). */
export const PROVIDERS_DO_CANAL_FIXADO = ["waha", "meta_cloud", "zernio"] as const;

export function canalFixadoDoGatilho(cfg: unknown): string | null {
  const c = cfg as { kind?: unknown; params?: { channel_session_id?: unknown } } | null | undefined;
  if (c?.kind !== "appointment_attended" && c?.kind !== "appointment_no_show") return null;
  const id = c.params?.channel_session_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

type Canal = { provider: string | null; archived_at: string | null } | null;

/** Mínimo que a conferência pede do client — o supabase real ou um dublê. */
export type LeitorDeCanal = (orgId: string, channelId: string) => Promise<{ data: Canal; error: { message: string } | null }>;

export type RecusaDoCanal = { code: string; message: string; status: number };

export async function conferirCanalDoGatilho(
  ler: LeitorDeCanal,
  orgId: string,
  cfg: unknown,
): Promise<RecusaDoCanal | null> {
  const id = canalFixadoDoGatilho(cfg);
  if (!id) return null;
  const { data, error } = await ler(orgId, id);
  if (error) return { code: "internal_error", message: error.message, status: 500 };
  if (!data) {
    return { code: "trigger_channel_not_found", message: "O número escolhido para o envio não existe nesta conta. Escolha outro.", status: 422 };
  }
  if (data.archived_at) {
    return { code: "trigger_channel_archived", message: "O número escolhido para o envio foi excluído. Escolha outro.", status: 422 };
  }
  if (!(PROVIDERS_DO_CANAL_FIXADO as readonly string[]).includes(data.provider ?? "")) {
    return { code: "trigger_channel_unsupported", message: "O acompanhamento só sai por número de WhatsApp. Escolha outro.", status: 422 };
  }
  return null;
}

/** O leitor real: filtra a organização explicitamente (vale também com o admin client). */
export function leitorDeCanal(db: SupabaseClient): LeitorDeCanal {
  return async (orgId, channelId) => {
    const { data, error } = await db
      .from("channel_sessions")
      .select("provider, archived_at")
      .eq("organization_id", orgId)
      .eq("id", channelId)
      .maybeSingle();
    return { data: data as Canal, error };
  };
}
