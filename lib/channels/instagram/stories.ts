/**
 * Stories da conta profissional conectada, para o bônus da equipe (rotina "2
 * stories por dia"). O story some em 24h: o cron lê de hora em hora e junta os
 * ids por dia (`lib/bonus/stories.ts`).
 *
 * ⚠️ A borda `/{ig-user-id}/stories` está documentada pela Meta só no caminho do
 * Login do Facebook; este canal usa o Login do Instagram. 400/403 vira
 * `sem_permissao`, e a tela manda o aprovador lançar à mão.
 * Token no cabeçalho, nunca na URL (a URL não é logada de todo jeito).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { StoryLido } from "@/lib/bonus/stories";
import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_INSTAGRAM } from "../capabilities";
import { baseDoInstagram } from "./graph";

export type LeituraDeStories =
  | { ok: true; stories: StoryLido[] }
  | { ok: false; motivo: "sem_conexao" | "sem_permissao" | "falha" };

export async function storiesRecentes(
  token: string,
  igAccountId: string,
  buscar: typeof fetch = fetch,
): Promise<LeituraDeStories> {
  const url = `${baseDoInstagram()}/${graphVersion()}/${encodeURIComponent(igAccountId)}/stories?fields=id,timestamp&limit=50`;
  try {
    const res = await buscar(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 400 || res.status === 403) {
      logger.info("[instagram.stories] leitura recusada", { status: res.status });
      return { ok: false, motivo: "sem_permissao" };
    }
    if (!res.ok) return { ok: false, motivo: "falha" };
    const corpo = (await res.json()) as { data?: Array<{ id?: unknown; timestamp?: unknown }> };
    const stories = (corpo.data ?? []).filter(
      (s): s is StoryLido => typeof s.id === "string" && typeof s.timestamp === "string",
    );
    return { ok: true, stories };
  } catch (err) {
    logger.info("[instagram.stories] leitura falhou", { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, motivo: "falha" };
  }
}

export async function lerStoriesDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<LeituraDeStories> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("ig_account_id, ig_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .not("ig_token_encrypted", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, motivo: "falha" };
  const linha = data as { ig_account_id: string | null; ig_token_encrypted: string | null } | null;
  if (!linha?.ig_account_id || !linha.ig_token_encrypted) return { ok: false, motivo: "sem_conexao" };
  const token = await decryptWebhookSecret(admin, linha.ig_token_encrypted);
  if (!token) return { ok: false, motivo: "falha" };
  return storiesRecentes(token, linha.ig_account_id);
}
