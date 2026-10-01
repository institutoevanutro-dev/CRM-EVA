/**
 * O caminho ÚNICO que grava o canal oficial — o formulário manual
 * (`POST /api/v1/channels/official`) e o Cadastro Incorporado
 * (`POST .../cadastro-incorporado`) passam por aqui.
 *
 * VALIDA ANTES DE GRAVAR: gravar primeiro e descobrir depois é o que faz o
 * operador achar que conectou e só entender que não na primeira mensagem que
 * não sai. Uma sessão oficial por org: se já existe (inclusive arquivada), é
 * ATUALIZADA (e ressuscitada) — nunca nasce uma segunda.
 *
 * `motivo` volta SEM traduzir: são chaves do dicionário, a rota aplica `t()`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta } from "@/lib/channels/meta/app";
import { assinarWebhookDaConta } from "@/lib/channels/meta/assinar-webhook";
import { conferirNumeroDaConta, validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { logger } from "@/lib/logger";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import type { Coexistencia } from "./coexistencia";

export interface ConexaoOficialInput {
  organizationId: string;
  userId: string;
  requestId: string;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  /** Base pública da instalação (sem barra final): o callback é `${base}/api/v1/webhooks/meta/<token>`. */
  callbackBase: string;
  /** Mesclado na metadata junto de `webhook_da_conta` (ex.: `cadastro_incorporado`, `pin_cifrado`). */
  metadataExtra?: Record<string, unknown>;
}

export type ConexaoOficialResultado =
  | {
      ok: true;
      sessionId: string;
      displayName: string;
      phoneNumber: string | null;
      webhook: { assinado: true } | { assinado: false; motivo: string };
      /** `false` quando `metadataExtra` não foi gravado — quem depende dele (o PIN) não segue. */
      metadataGravada: boolean;
    }
  | { ok: false; status: 422 | 500; codigo: "invalid_request" | "internal_error"; motivo: string };

export const MOTIVO_NUMERO_EM_OUTRA_ORG = "este número já está conectado em outra organização";
export const MOTIVO_NUMERO_EM_OUTRO_CANAL_DA_ORG = "este número já está em outro canal desta organização";
const MOTIVO_CIFRA_INDISPONIVEL =
  "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado";
const MOTIVO_SESSAO_SEM_ENDERECO = "a sessão foi gravada sem endereço de recebimento. Reconecte o canal";

interface LinhaOficial {
  id: string;
  meta_phone_number_id?: string | null;
  archived_at?: string | null;
}

/**
 * Qual linha oficial da org esta conexão atualiza. A org pode ter mais de uma
 * (produção, 01/10: uma `WORKING` do número e uma `FAILED` de outro número), e
 * um `maybeSingle` ali devolvia ERRO, que virava "não existe" e um INSERT que
 * batia no índice único do próprio número. Preferência: a ativa do MESMO número,
 * depois qualquer ativa, depois a arquivada do mesmo número, depois qualquer.
 */
function escolherExistente(linhas: LinhaOficial[], phoneNumberId: string): LinhaOficial | null {
  const ativa = (l: LinhaOficial) => !l.archived_at;
  const mesmo = (l: LinhaOficial) => l.meta_phone_number_id === phoneNumberId;
  return (
    linhas.find((l) => ativa(l) && mesmo(l)) ??
    linhas.find(ativa) ??
    linhas.find(mesmo) ??
    linhas[0] ??
    null
  );
}

export async function conectarCanalOficial(
  admin: SupabaseClient,
  input: ConexaoOficialInput,
): Promise<ConexaoOficialResultado> {
  const { organizationId: orgId, userId, requestId, phoneNumberId, wabaId, token } = input;

  // VALIDA ANTES DE GRAVAR — a função não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde.
  const validacao = await validateMetaCredentials({ phoneNumberId, token });
  if (!validacao.ok) return { ok: false, status: 422, codigo: "invalid_request", motivo: validacao.motivo };

  // O número tem que ser DESTA conta: o webhook é assinado por WABA, e um ID de
  // conta errado assinaria a conta alheia, deixando este número surdo.
  const daConta = await conferirNumeroDaConta({ wabaId, phoneNumberId, token });
  if (!daConta.ok) return { ok: false, status: 422, codigo: "invalid_request", motivo: daConta.motivo };

  const cifrado = await encryptWebhookSecret(admin, token);
  // Sem a GUC de cifra configurada, gravar o token em claro seria pior que recusar.
  if (!cifrado) return { ok: false, status: 422, codigo: "invalid_request", motivo: MOTIVO_CIFRA_INDISPONIVEL };

  // A busca NÃO filtra `archived_at`: um canal oficial excluído é exatamente o
  // que precisa ser achado para voltar. Ignorá-lo criaria uma SEGUNDA linha
  // oficial na org — e a velha continuaria segurando o par (org, número) na
  // trava da 0106.
  const buscarExistentes = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .order("created_at", { ascending: true })
      // ponytail: teto de 20 linhas oficiais por org (hoje são 1-2); acima disso a
      // do mesmo número pode ficar de fora e virar INSERT → 23505. Filtrar por
      // `meta_phone_number_id` numa segunda consulta se alguma org chegar perto.
      .limit(20);
  const { data: existentesRaw } = await queryTolerantToMissingArchived(
    () => buscarExistentes(`id, meta_phone_number_id, ${ARCHIVED_AT}`),
    () => buscarExistentes("id, meta_phone_number_id"),
  );
  const existente = escolherExistente((existentesRaw ?? []) as unknown as LinhaOficial[], phoneNumberId);

  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) é um índice PARCIAL (0107, `where archived_at is null`), só
  // inferível por `ON CONFLICT` repetindo o predicado — e o cliente do
  // PostgREST não expõe isso.
  //
  // O update passa por `reactivateChannelSession` porque reconectar é
  // ressuscitar: o mesmo patch que devolve status, credencial e número devolve a
  // linha à vida. Para o canal já ativo é um no-op — e a auditoria de volta sai
  // de lá, junto da ressurreição.
  const { error } = existente
    ? await reactivateChannelSession(
        admin,
        { organizationId: orgId, channelSessionId: existente.id, archivedAt: existente.archived_at ?? null },
        linha,
        { userId, requestId, metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number } },
      )
    : await admin.from("channel_sessions").insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      });

  if (error) {
    // 23505 é recusa, não 500 (P15b) — mas só quando a trava diz QUAL é o caso:
    // `..._meta_phone_number_id_ativo_unique` = o número está ativo em OUTRA org
    // (a linha desta foi achada acima); `..._phone_per_org_unique` = outro canal
    // DESTA org (ex.: a sessão por QR) já tem o número. Outra trava cai no 500.
    if (error.code === "23505") {
      const trava = error.message ?? "";
      if (trava.includes("channel_sessions_meta_phone_number_id_ativo_unique")) {
        return { ok: false, status: 422, codigo: "invalid_request", motivo: MOTIVO_NUMERO_EM_OUTRA_ORG };
      }
      if (trava.includes("channel_sessions_phone_per_org_unique")) {
        return { ok: false, status: 422, codigo: "invalid_request", motivo: MOTIVO_NUMERO_EM_OUTRO_CANAL_DA_ORG };
      }
    }
    return { ok: false, status: 500, codigo: "internal_error", motivo: error.message ?? "channel_session_write_failed" };
  }

  // O app da Meta tem UM callback; sem o override por WABA, a conta de uma
  // segunda organização entrega na URL de outra sessão e nunca recebe nada
  // (medido em produção em 26/09/2026). Falhar aqui NÃO desfaz a conexão.
  // Releitura porque `reactivateChannelSession` não devolve a linha: pelo id
  // quando atualizou; pelo número ativo (único pelo índice) quando inseriu.
  const lerSessao = () => {
    const q = admin.from("channel_sessions").select("id, webhook_path_token").eq("organization_id", orgId);
    return existente ? q.eq("id", existente.id) : q.eq("provider", CHANNEL_PROVIDER_META).eq("meta_phone_number_id", phoneNumberId);
  };
  const { data: sessaoRaw } = await queryTolerantToMissingArchived(
    () => lerSessao().is(ARCHIVED_AT, null).maybeSingle(),
    () => lerSessao().maybeSingle(),
  );
  const sessao = sessaoRaw as { id: string; webhook_path_token?: string | null } | null;
  if (!sessao) {
    return { ok: false, status: 500, codigo: "internal_error", motivo: "channel_session_not_found_after_write" };
  }
  const assinatura = sessao.webhook_path_token
    ? await assinarWebhookDaConta({
        wabaId,
        token,
        callbackUrl: `${input.callbackBase}/api/v1/webhooks/meta/${sessao.webhook_path_token}`,
        verifyToken: (await appDaMeta()).verifyToken,
      })
    : ({ ok: false, motivo: MOTIVO_SESSAO_SEM_ENDERECO } as const);

  if (!assinatura.ok) {
    logger.warn("meta.webhook_da_conta.nao_assinado", { organization_id: orgId, waba_id: wabaId, motivo: assinatura.motivo });
  }

  // A metadata é lida AGORA, depois da Meta (até 15s), e não junto da sessão: ela
  // guarda também `ai_gate` e os números de teste do pré-go-live, e um admin que
  // mudasse o gate durante a chamada seria revertido em silêncio.
  const erroMetadata = await mesclarMetadata(admin, orgId, sessao.id, {
    ...(input.metadataExtra ?? {}),
    webhook_da_conta: {
      assinado: assinatura.ok,
      ...(assinatura.ok ? {} : { motivo: assinatura.motivo }),
      em: new Date().toISOString(),
    },
  });
  if (erroMetadata) {
    logger.warn("meta.webhook_da_conta.nao_gravado", { organization_id: orgId, motivo: erroMetadata });
  }

  return {
    ok: true,
    sessionId: sessao.id,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    webhook: assinatura.ok ? { assinado: true } : { assinado: false, motivo: assinatura.motivo },
    metadataGravada: !erroMetadata,
  };
}

/**
 * Ler-mesclar-gravar de `metadata`, sempre por (org, id). Devolve a mensagem de
 * erro ou `null`.
 * ponytail: sobra uma janela de milissegundos entre o select e o update. Não há
 * RPC genérica de merge para esta coluna (só a do pré-go-live, 0218); vira RPC
 * com `jsonb_set` se a janela algum dia morder.
 */
async function mesclarMetadata(
  admin: SupabaseClient,
  orgId: string,
  sessionId: string,
  chaves: Record<string, unknown>,
): Promise<string | null> {
  const { data: atual, error: erroLeitura } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", orgId)
    .eq("id", sessionId)
    .maybeSingle();
  if (erroLeitura) return erroLeitura.message;
  const lida = (atual as { metadata?: unknown } | null)?.metadata;
  const base = (lida && typeof lida === "object" ? lida : {}) as Record<string, unknown>;
  const { error } = await admin
    .from("channel_sessions")
    .update({ metadata: { ...base, ...chaves } })
    .eq("organization_id", orgId)
    .eq("id", sessionId);
  return error?.message ?? null;
}

/** O `pin_cifrado` que um FINISH anterior deixou na sessão oficial deste número, ou `null`. */
export async function pinCifradoDaSessaoOficial(
  admin: SupabaseClient,
  organizationId: string,
  phoneNumberId: string,
): Promise<string | null> {
  const base = () =>
    admin
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .eq("meta_phone_number_id", phoneNumberId);
  const { data } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  const pin = (data as { metadata?: { pin_cifrado?: unknown } } | null)?.metadata?.pin_cifrado;
  return typeof pin === "string" && pin ? pin : null;
}

/** Grava `metadata.coexistencia` da sessão oficial (rota do cadastro, `/sincronizar`, worker do histórico). */
export async function gravarCoexistencia(
  admin: SupabaseClient,
  organizationId: string,
  sessionId: string,
  coex: Coexistencia,
): Promise<void> {
  const erro = await mesclarMetadata(admin, organizationId, sessionId, { coexistencia: coex });
  if (erro) logger.warn("meta.coexistencia.nao_gravada", { organization_id: organizationId, session: sessionId, motivo: erro });
}
