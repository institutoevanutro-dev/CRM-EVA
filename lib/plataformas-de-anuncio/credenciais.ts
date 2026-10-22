/**
 * A credencial de conversões da organização — lida e decifrada.
 *
 * ⚠️ SEMPRE COM `organization_id` NO FILTRO (lição da #236 em `channel_sessions`).
 * ⚠️ EXIGE O ADMIN CLIENT: `ad_platform_connections` é deny-all (0213).
 *
 * Cada ausência tem nome próprio porque pede coisa diferente de quem lê a tela.
 * `cifra_indisponivel` é problema da INSTALAÇÃO (chave mestra fora do ambiente):
 * refazer o cadastro não resolve.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { EVENTO_AGENDOU, type CredencialDeConversao, type NomeDoEvento, type PlataformaDeAnuncio } from "./types";

export type MotivoSemCredencial =
  | "sem_conexao"
  | "conexao_desabilitada"
  | "credencial_incompleta"
  | "cifra_indisponivel";

export type LeituraDeCredencial =
  | { ok: true; credencial: CredencialDeConversao }
  | { ok: false; motivo: MotivoSemCredencial };

interface Linha {
  enabled: boolean;
  deposit_paid_enabled: boolean | null;
  google_deposit_paid_conversion_action_id: string | null;
  dataset_id: string | null;
  access_token_encrypted: string | null;
  test_event_code: string | null;
  google_customer_id: string | null;
  google_login_customer_id: string | null;
  google_conversion_action_id: string | null;
  google_oauth_client_id: string | null;
  google_oauth_client_secret_encrypted: string | null;
  google_refresh_token_encrypted: string | null;
  google_developer_token_encrypted: string | null;
}

const COLUNAS =
  "enabled, deposit_paid_enabled, google_deposit_paid_conversion_action_id, dataset_id, access_token_encrypted, test_event_code, google_customer_id, " +
  "google_login_customer_id, google_conversion_action_id, google_oauth_client_id, " +
  "google_oauth_client_secret_encrypted, google_refresh_token_encrypted, google_developer_token_encrypted";

export async function lerCredencial(
  admin: SupabaseClient,
  organizationId: string,
  plataforma: PlataformaDeAnuncio,
  /**
   * Cada evento é ligado à parte: `enabled` é o do agendamento (o nome antigo
   * ficou), `deposit_paid_enabled` o do sinal pago. No Google, cada evento tem a
   * sua ação de conversão, e a credencial devolvida já leva a do evento.
   */
  evento: NomeDoEvento,
): Promise<LeituraDeCredencial> {
  const { data, error } = await admin
    .from("ad_platform_connections")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("platform", plataforma)
    .maybeSingle();

  if (error) {
    logger.error("[conversoes.credencial] leitura falhou", { organizationId, plataforma, error: error.message });
    return { ok: false, motivo: "sem_conexao" };
  }
  if (!data) return { ok: false, motivo: "sem_conexao" };
  const linha = data as unknown as Linha;
  const agendou = evento === EVENTO_AGENDOU;
  if (!(agendou ? linha.enabled : linha.deposit_paid_enabled === true)) {
    return { ok: false, motivo: "conexao_desabilitada" };
  }

  const decifra = async (v: string | null) => (v ? decryptWebhookSecret(admin, v) : null);

  if (plataforma === "meta_ads") {
    if (!linha.dataset_id || !linha.access_token_encrypted) return { ok: false, motivo: "credencial_incompleta" };
    const token = await decifra(linha.access_token_encrypted);
    if (!token) return { ok: false, motivo: "cifra_indisponivel" };
    return {
      ok: true,
      credencial: {
        plataforma,
        datasetId: linha.dataset_id,
        accessToken: token,
        testEventCode: linha.test_event_code,
      },
    };
  }

  const acao = agendou ? linha.google_conversion_action_id : linha.google_deposit_paid_conversion_action_id;
  if (
    !linha.google_customer_id ||
    !acao ||
    !linha.google_oauth_client_id ||
    !linha.google_oauth_client_secret_encrypted ||
    !linha.google_refresh_token_encrypted
  ) {
    return { ok: false, motivo: "credencial_incompleta" };
  }
  const [clientSecret, refreshToken, developerToken] = await Promise.all([
    decifra(linha.google_oauth_client_secret_encrypted),
    decifra(linha.google_refresh_token_encrypted),
    // Opcional: o Google aposentou o developer token em 09/09/2026.
    decifra(linha.google_developer_token_encrypted),
  ]);
  if (!clientSecret || !refreshToken) return { ok: false, motivo: "cifra_indisponivel" };
  if (linha.google_developer_token_encrypted && !developerToken) return { ok: false, motivo: "cifra_indisponivel" };
  return {
    ok: true,
    credencial: {
      plataforma,
      customerId: linha.google_customer_id,
      loginCustomerId: linha.google_login_customer_id,
      conversionActionId: acao,
      clientId: linha.google_oauth_client_id,
      clientSecret,
      refreshToken,
      developerToken,
    },
  };
}
