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
  ErroDaMeta,
  escolherNumero,
  FALHA_GENERICA_DA_META,
  gerarPin,
  numerosDaConta,
  pedirSincronizacao,
  registrarNumero,
  trocarCodigo,
} from "@/lib/channels/meta/cadastro-incorporado";
import { EVENTO_COEXISTENCIA, EVENTO_NUMERO_NOVO, type Coexistencia } from "@/lib/channels/meta/coexistencia";
import { conectarCanalOficial, gravarCoexistencia } from "@/lib/channels/meta/conectar-canal-oficial";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

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

  // 3. register só para número novo (coexistência mantém o número no aplicativo)
  const admin = createAdminClient();
  let pinCifrado: string | null = null;
  if (!coexistencia) {
    const pin = gerarPin();
    pinCifrado = await encryptWebhookSecret(admin, pin);
    if (!pinCifrado) {
      return fail("invalid_request", t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"), 422, { requestId });
    }
    try {
      await registrarNumero(token, phoneNumberId, pin);
    } catch (err) {
      return fail("invalid_request", t(frasePara("register", err, orgId)), 422, { requestId });
    }
  }

  // 4. A sessão legada (QR) deste número já caiu (a Meta desconecta os aparelhos).
  //    ANTES de gravar a oficial (ruling P1): o índice único
  //    `channel_sessions_phone_per_org_unique (organization_id, phone_number)
  //    where archived_at is null` ainda tem a linha legada ativa com este número.
  let legada: string | null = null;
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
    },
  });
  // `traduzirMotivo` cobre os motivos do formulário (prefixo de rede); `t()` os do dicionário.
  if (!r.ok) return fail(r.codigo, traduzirMotivo(r.motivo, t), r.status, { requestId });

  // 6. coexistência: contatos, depois histórico. Falha NÃO desfaz a conexão.
  let coex: Coexistencia | null = null;
  if (coexistencia) {
    const contatos = await pedirSincronizacao(token, phoneNumberId, "smb_app_state_sync");
    const historico = await pedirSincronizacao(token, phoneNumberId, "history");
    coex = { onboarding_em: agora, pedidos: { contatos, historico }, historico: null };
    await gravarCoexistencia(admin, orgId, r.sessionId, coex);
  }

  // 7. trilha — sem token, sem PIN
  void audit({
    action: "channel.official_connected_es",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: r.sessionId,
    requestId,
    metadata: { coexistencia, evento, waba_id, phone_number_id: phoneNumberId, sessao_legada_arquivada: legada, pedidos: coex?.pedidos ?? null },
  });

  return ok({
    connected: true,
    displayName: r.displayName,
    phoneNumber: r.phoneNumber,
    coexistencia,
    webhook: r.webhook.assinado ? { assinado: true } : { assinado: false, motivo: traduzirMotivo(r.webhook.motivo, t) },
  });
}
