/**
 * Adapter do Instagram. Etapa 1 só RECEBE (webhook → lib/channels/instagram/ingest.ts):
 * envio chega na etapa 2 (spec §5.5). Recusar com código próprio, e não com o genérico,
 * deixa a tela explicar "responder pelo Instagram ainda não está disponível".
 */
import { graphVersion } from "@/lib/graph-version";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { BASE_DO_INSTAGRAM } from "../instagram/graph";
import type { ChannelAdapter, ChannelHealth, ChannelTenantScope } from "../types";

/**
 * O token em claro da sessão — organização + `ig_account_id` (= `sessionRef`,
 * ver `resolveSessionRef`) ativa, nunca arquivada. `null` quando não há
 * credencial (sessão sem token, cifra indisponível, linha arquivada): o
 * chamador trata como "não deu para perguntar", nunca como "caiu".
 */
async function resolveInstagramToken(
  input: ChannelTenantScope & { sessionRef: string },
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("ig_token_encrypted")
    .eq("organization_id", input.organizationId)
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", input.sessionRef)
    .is("archived_at", null)
    .maybeSingle();
  const cifrado = (data as { ig_token_encrypted?: string | null } | null)?.ig_token_encrypted;
  if (error || !cifrado) return null;
  return decryptWebhookSecret(admin, cifrado);
}

export const instagramAdapter: ChannelAdapter = {
  provider: "meta_instagram",
  resolveRecipient: () => null,
  isConfigured: () => false,
  async send() {
    throw new Error("instagram_envio_indisponivel");
  },
  /**
   * `checkHealth` é OBRIGATÓRIO para todo provider de MENSAGEM (o cron de
   * saúde pula, sem log, quem não implementa — `tests/unit/saude-dos-canais-
   * oficiais.test.ts`).
   *
   * Sonda REAL: `GET /me` com o token da sessão. Sem isso, toda sessão do
   * Instagram conectada abria um aviso "não sei" na Central e nunca resolvia
   * — `reachable:false` incondicional é indistinguível de "nunca perguntei" e
   * de "não consigo perguntar", e a Central não tinha como saber a diferença.
   *
   * `reachable = res.ok`: qualquer resposta HTTP (mesmo de erro) prova que a
   * chamada chegou — o `status` cru vai junto para quem for investigar depois.
   * Só o erro de REDE (`fetch` lança — timeout, DNS, TLS) é "não sei", sem
   * status. O token NUNCA entra no `detail` nem em log — só o `status` e um
   * motivo fixo em português.
   */
  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const token = await resolveInstagramToken(input);
    if (!token) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };

    let res: Response;
    try {
      // Teto de espera: sem ele, uma Graph pendurada pendura o cron de saúde
      // inteiro, não só esta sessão.
      res = await fetch(`${BASE_DO_INSTAGRAM}/${graphVersion()}/me?fields=user_id,username`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { reachable: false, status: null, detail: "Instagram não respondeu" };
    }

    const status = String(res.status);
    if (res.ok) return { reachable: true, status, detail: null };

    const detail =
      res.status === 400 || res.status === 401 || res.status === 403
        ? "chave do Instagram vencida ou revogada"
        : `Instagram recusou a chamada (${res.status})`;
    return { reachable: false, status, detail };
  },
  codes: {
    notConfigured: "instagram_nao_configurado",
    sendFailed: "instagram_envio_indisponivel",
    unknownError: "instagram_erro_desconhecido",
  },
};
