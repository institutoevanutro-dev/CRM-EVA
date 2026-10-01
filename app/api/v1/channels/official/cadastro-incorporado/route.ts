/**
 * POST /api/v1/channels/official/cadastro-incorporado — fecha o Cadastro
 * Incorporado (botão da Meta): troca o `code`, confere o token, resolve o
 * número e grava pelo MESMO caminho do formulário manual (`conectarCanalOficial`).
 *
 * - Número novo (`FINISH`): `register` com PIN gerado aqui; o PIN fica CIFRADO na
 *   metadata e nunca volta nem vai ao log.
 * - Coexistência (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`): o número continua no
 *   aplicativo do celular — NÃO registra; pede contatos e histórico
 *   (`smb_app_data`), e falha ali não desfaz a conexão (há 24 h para repetir,
 *   ver `./sincronizar`).
 *
 * Toda frase devolvida é chave do dicionário e sai traduzida (ruling P13); o
 * texto cru da Meta só vai ao log.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { appDaMeta } from "@/lib/channels/meta/app";
import {
  arquivarSessaoLegadaDoNumero,
  conferirToken,
  derrubarSessaoLegadaNoWaha,
  desarquivarSessaoLegada,
  ErroDaMeta,
  escolherNumero,
  FALHA_GENERICA_DA_META,
  gerarPin,
  numerosDaConta,
  pedirSincronizacao,
  registrarNumero,
  type SessaoLegadaArquivada,
  trocarCodigo,
} from "@/lib/channels/meta/cadastro-incorporado";
import { EVENTO_COEXISTENCIA, EVENTO_NUMERO_NOVO, SINCRONIZACAO_TEM_CONSUMIDOR, type Coexistencia } from "@/lib/channels/meta/coexistencia";
import { conectarCanalOficial, gravarCoexistencia } from "@/lib/channels/meta/conectar-canal-oficial";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { publicBase, traduzirMotivo } from "../route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  code: z.string().min(10).max(2000),
  evento: z.string().min(1).max(80),
  waba_id: z.string().min(5).max(40).nullable(),
  phone_number_id: z.string().min(5).max(40).nullable(),
});

/** Frase para a tela (a mapeada da Meta, ou a genérica); o cru vai ao log. */
function frasePara(etapa: string, err: unknown, orgId: string): string {
  logger.warn("[cadastro-incorporado] falha na Meta", {
    organization_id: orgId,
    etapa,
    error: err instanceof ErroDaMeta ? err.detalhe : err instanceof Error ? err.message : String(err),
  });
  return err instanceof ErroDaMeta ? err.message : FALHA_GENERICA_DA_META;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_request", t("code, evento e waba_id são obrigatórios"), 422, { requestId });
  const { code, evento, waba_id, phone_number_id } = parsed.data;
  const coexistencia = evento === EVENTO_COEXISTENCIA;
  if (!coexistencia && evento !== EVENTO_NUMERO_NOVO) {
    return fail("invalid_request", t("o fluxo da Meta não terminou. Tente de novo."), 422, { requestId });
  }
  if (!waba_id) return fail("invalid_request", t("a Meta não devolveu a conta do WhatsApp Business. Tente de novo."), 422, { requestId });

  const app = await appDaMeta();
  if (!app.appId || !app.appSecret) {
    return fail("invalid_request", t("o Cadastro Incorporado não está configurado nesta instalação"), 422, { requestId });
  }

  // 1. troca do code (vale 30 s) + conferência do token
  let token: string;
  try {
    token = await trocarCodigo({ appId: app.appId, appSecret: app.appSecret }, code);
  } catch (err) {
    return fail("invalid_request", t(frasePara("troca", err, orgId)), 422, { requestId });
  }
  const conferido = await conferirToken({ appId: app.appId, appSecret: app.appSecret }, token);
  if (!conferido.ok) return fail("invalid_request", t(conferido.motivo), 422, { requestId });

  // 2. número
  let numeros;
  try {
    numeros = await numerosDaConta(token, waba_id);
  } catch (err) {
    return fail("invalid_request", t(frasePara("phone_numbers", err, orgId)), 422, { requestId });
  }
  const escolha = escolherNumero(numeros, { phoneNumberId: phone_number_id, coexistencia });
  if (!escolha.ok) return fail("invalid_request", t(escolha.motivo), 422, { requestId });
  const phoneNumberId = escolha.numero.id;
  // `+` + dígitos: a MESMA grafia que `conectarCanalOficial` grava em `phone_number`.
  const phoneNumber = escolha.numero.displayPhoneNumber ? `+${escolha.numero.displayPhoneNumber.replace(/\D/g, "")}` : null;

  // 3. PIN do número novo, cifrado ANTES de qualquer coisa: ele vai na metadata
  //    da sessão e só depois disso é enviado à Meta no `register` (passo 6) —
  //    PIN registrado na Meta e perdido aqui trancaria o número.
  const admin = createAdminClient();
  let pin: string | null = null;
  let pinCifrado: string | null = null;
  if (!coexistencia) {
    // Retry do FINISH: o register anterior pode ter chegado à Meta com o PIN
    // gravado; um PIN novo daria mismatch e trancaria o número. Reaproveita.
    const { data: anterior } = await admin
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();
    const pinAnterior = (anterior as { metadata?: { pin_cifrado?: unknown } } | null)?.metadata?.pin_cifrado;
    if (typeof pinAnterior === "string" && pinAnterior) {
      pinCifrado = pinAnterior;
      pin = await decryptWebhookSecret(admin, pinAnterior);
    } else {
      pin = gerarPin();
      pinCifrado = await encryptWebhookSecret(admin, pin);
    }
    if (!pin || !pinCifrado) {
      return fail("invalid_request", t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"), 422, { requestId });
    }
  }

  // 4. A sessão legada (QR) deste número já caiu (a Meta desconecta os aparelhos).
  //    ANTES de gravar a oficial (ruling P1): o índice único
  //    `channel_sessions_phone_per_org_unique (organization_id, phone_number)
  //    where archived_at is null` ainda tem a linha legada ativa com este número.
  //    Só no BANCO: o WAHA só cai depois da oficial gravada (passo 5).
  let legada: SessaoLegadaArquivada | null = null;
  try {
    legada = phoneNumber ? await arquivarSessaoLegadaDoNumero(admin, orgId, phoneNumber) : null;
  } catch (err) {
    logger.error("[cadastro-incorporado] sessão legada não arquivada", { organization_id: orgId, error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", t(FALHA_GENERICA_DA_META), 500, { requestId });
  }

  // 5. o MESMO caminho do formulário manual (atualiza a sessão oficial da org, se houver)
  const agora = new Date().toISOString();
  const r = await conectarCanalOficial(admin, {
    organizationId: orgId,
    userId: authz.user.id,
    requestId,
    phoneNumberId,
    wabaId: waba_id,
    token,
    callbackBase: publicBase(req),
    metadataExtra: {
      cadastro_incorporado: { evento, em: agora },
      ...(pinCifrado ? { pin_cifrado: pinCifrado } : {}),
      // Número novo não é coexistência: a de uma conexão anterior não vale mais.
      ...(coexistencia ? {} : { coexistencia: null }),
    },
  }).catch((err: unknown) => ({
    // Lançar aqui deixaria a legada arquivada sem oficial nenhuma: vira recusa e desfaz abaixo.
    ok: false as const,
    status: 500,
    codigo: "internal_error" as const,
    motivo: err instanceof Error ? err.message : String(err),
  }));
  if (!r.ok) {
    // A oficial não foi gravada: devolve a legada (o QR segue de pé).
    if (legada) {
      await desarquivarSessaoLegada(admin, orgId, legada).catch((err: unknown) =>
        logger.error("[cadastro-incorporado] sessão legada não desarquivada", {
          organization_id: orgId,
          session: legada!.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // Frase do dicionário sai traduzida; texto cru (da Meta ou do banco) só vai ao log.
    if (r.motivo in DICIONARIO) return fail(r.codigo, t(r.motivo), r.status, { requestId });
    logger.warn("[cadastro-incorporado] conexão recusada", { organization_id: orgId, status: r.status, motivo: r.motivo });
    return fail(r.codigo, t(FALHA_GENERICA_DA_META), r.status, { requestId });
  }

  if (legada) await derrubarSessaoLegadaNoWaha(orgId, legada);

  // 6. register só para número novo, DEPOIS da sessão gravada com o PIN cifrado
  //    (a validação da credencial funciona antes do register). Falha aqui não
  //    apaga a sessão nem o PIN: refazer o fluxo reaproveita a linha.
  if (pin && !r.metadataGravada) {
    // PIN não guardado: registrar agora trancaria o número com um PIN perdido.
    logger.error("[cadastro-incorporado] metadata não gravada; register não enviado", { organization_id: orgId, session: r.sessionId });
    return fail("internal_error", t(FALHA_GENERICA_DA_META), 500, { requestId });
  }
  if (pin) {
    try {
      await registrarNumero(token, phoneNumberId, pin);
    } catch (err) {
      return fail("invalid_request", t(frasePara("register", err, orgId)), 422, { requestId });
    }
  }

  // 7. coexistência: contatos, depois histórico. Falha NÃO desfaz a conexão.
  //    Sem consumidor dos webhooks (Parte A), NÃO pede: o histórico é pedido uma vez só.
  let coex: Coexistencia | null = null;
  if (coexistencia) {
    const contatos = SINCRONIZACAO_TEM_CONSUMIDOR ? await pedirSincronizacao(token, phoneNumberId, "smb_app_state_sync") : null;
    const historico = SINCRONIZACAO_TEM_CONSUMIDOR ? await pedirSincronizacao(token, phoneNumberId, "history") : null;
    coex = { onboarding_em: agora, pedidos: { contatos, historico }, historico: null };
    await gravarCoexistencia(admin, orgId, r.sessionId, coex);
  }

  // 8. trilha — sem token, sem PIN
  void audit({
    action: "channel.official_connected_es",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: r.sessionId,
    requestId,
    metadata: { coexistencia, evento, waba_id, phone_number_id: phoneNumberId, sessao_legada_arquivada: legada?.id ?? null, pedidos: coex?.pedidos ?? null },
  });

  return ok({
    connected: true,
    displayName: r.displayName,
    phoneNumber: r.phoneNumber,
    coexistencia,
    webhook: r.webhook.assinado ? { assinado: true } : { assinado: false, motivo: traduzirMotivo(r.webhook.motivo, t) },
  });
}
