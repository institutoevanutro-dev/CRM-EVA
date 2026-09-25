/**
 * Adapter do Instagram. Etapa 1 só RECEBE (webhook → lib/channels/instagram/ingest.ts):
 * envio chega na etapa 2 (spec §5.5). Recusar com código próprio, e não com o genérico,
 * deixa a tela explicar "responder pelo Instagram ainda não está disponível".
 */
import { graphVersion } from "@/lib/graph-version";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { MAX_MEDIA_BYTES, MediaTooLargeError, type FetchedMedia } from "@/lib/messaging/media/types";

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

/**
 * Hosts de onde o Instagram serve mídia de mensagem — por SUFIXO, nunca host
 * exato, e SEM MEDIR contra uma conta real (não há uma nesta casa; mesma
 * lacuna que `meta-cloud.ts:227-230` já declara para o WhatsApp oficial).
 *
 * O que sustenta a lista:
 * - `lookaside.fbsbx.com` — o host relatado em payload real de webhook de
 *   mensagem do Instagram por integradores terceiros (Manychat, CM.com):
 *   anexos chegam como `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=…`.
 *   A doc oficial da Meta (`developers.facebook.com/documentation/business-
 *   messaging/instagram-messaging/webhooks`) não publica o host — só mostra
 *   `payload.url` como placeholder —, então este item vem de payload
 *   observado, não de contrato documentado.
 * - `.cdninstagram.com` — CDN de foto de perfil (`scontent.cdninstagram.com`),
 *   já em uso por `perfilDoRemetente` (`../instagram/graph.ts`, campo
 *   `profile_pic`); um anexo de mensagem pode sair do mesmo CDN.
 * - `.fbcdn.net` — CDN geral da Meta, o MESMO sufixo que `meta-cloud.ts` já
 *   allowlista para mídia do WhatsApp oficial.
 *
 * Um host legítimo recusado faz a mídia nunca chegar, com um erro que parece
 * problema de segurança e manda quem opera investigar o lugar errado — por
 * isso a lista cresce por SUFIXO da Meta antes de cresce por host solto, e só
 * com o mesmo tipo de evidência (payload real, não achismo).
 */
const HOSTS_DE_MIDIA_DO_INSTAGRAM = [".cdninstagram.com", ".fbcdn.net", ".fbsbx.com"] as const;

function hostDeMidiaPermitido(hostname: string): boolean {
  return HOSTS_DE_MIDIA_DO_INSTAGRAM.some(
    (sufixo) => hostname === sufixo.slice(1) || hostname.endsWith(sufixo),
  );
}

const FETCH_TIMEOUT_MS = 30_000;

export const instagramAdapter: ChannelAdapter = {
  provider: "meta_instagram",
  resolveRecipient: () => null,
  isConfigured: () => false,
  async send() {
    throw new Error("instagram_envio_indisponivel");
  },
  /**
   * Baixa a mídia recebida — consumido por `workers/media-persist-worker.ts`,
   * que chama `url: msg.media_url` (a URL do CDN gravada em
   * `lib/channels/instagram/ingest.ts`, que EXPIRA). Sem este método a URL
   * nunca é seguida (o worker pula com `canal_sem_midia_de_entrada`) e a mídia
   * se perde para sempre quando o link vence.
   *
   * ⚠️ ALLOWLIST DE HOST, fail-closed, ANTES de qualquer fetch: a URL veio do
   * PAYLOAD do webhook, e segui-la cegamente é SSRF — mesmo que hoje ela
   * costume vir de um host da Meta. https exigido sempre (não só em produção):
   * mídia de paciente não tem por que aceitar downgrade.
   *
   * Depois do host, a mesma resolução de DNS que os outros canais com mídia
   * externa usam (`zernio`, `call-webhook`): um host público pode resolver
   * para IP privado NO MOMENTO do fetch (rede do compose, metadado de nuvem),
   * e só pagar o DNS de novo pega isso.
   */
  async fetchInboundMedia(
    input: ChannelTenantScope & { sessionRef: string; url: string; hintMime?: string | null },
  ): Promise<FetchedMedia> {
    let alvo: URL;
    try {
      alvo = new URL(input.url);
    } catch {
      throw new Error("instagram_media_invalid_url");
    }
    if (alvo.protocol !== "https:") {
      throw new Error(`instagram_media_host_nao_permitido: esquema ${alvo.protocol}`);
    }
    if (!hostDeMidiaPermitido(alvo.hostname)) {
      throw new Error(`instagram_media_host_nao_permitido: ${alvo.hostname}`);
    }
    await assertDestinoResolvidoSeguro(alvo.hostname);

    const res = await fetch(alvo.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`instagram_media_download_failed: ${res.status} ${res.statusText}`.trim());
    }

    // Mesmo par de checagem do irmão WAHA (`lib/messaging/media/waha-source.ts`):
    // o `content-length` declarado corta cedo, sem baixar o corpo inteiro; o
    // tamanho real do buffer é a prova, porque o header pode mentir ou faltar.
    const declarado = Number(res.headers.get("content-length") ?? 0);
    if (declarado > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

    const mime =
      res.headers.get("content-type")?.split(";")[0]?.trim() ||
      input.hintMime ||
      "application/octet-stream";
    return { buffer, mime };
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
   * Mesmo contrato do canal oficial (`meta-cloud.ts`): `status` é o
   * VOCABULÁRIO de `channel_sessions.status`, porque o cron de saúde grava o
   * valor na coluna e `avisoDaConexao` o lê. Qualquer resposta HTTP prova que a
   * chamada chegou (`reachable: true`): 2xx → `WORKING`; recusa → `FAILED`,
   * com o motivo em português. Só o erro de REDE (`fetch` lança: timeout, DNS,
   * TLS) é "não sei", sem status. O token NUNCA entra no `detail` nem em log.
   *
   * Devolver o código HTTP cru ("200") foi o defeito: violava o CHECK da
   * coluna a cada rodada e, lido como "sem problema", fechava o aviso de
   * renovação vencida que o cron de renovação tinha acabado de abrir.
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

    if (res.ok) return { reachable: true, status: "WORKING", detail: null };

    const detail =
      res.status === 400 || res.status === 401 || res.status === 403
        ? "chave do Instagram vencida ou revogada"
        : `Instagram recusou a chamada (${res.status})`;
    return { reachable: true, status: "FAILED", detail };
  },
  codes: {
    notConfigured: "instagram_nao_configurado",
    sendFailed: "instagram_envio_indisponivel",
    unknownError: "instagram_erro_desconhecido",
  },
};
