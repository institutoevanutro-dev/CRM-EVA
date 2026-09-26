/**
 * Renovação do token de 60 dias do Instagram — e o aviso quando ela falha.
 *
 * Toda consulta/escrita que nomeia o provider mora aqui (o `lint:channels`
 * proíbe fora de `lib/channels/`); a rota do cron só chama esta rodada.
 *
 * ─── Query string, não cabeçalho ────────────────────────────────────────────
 *
 * A doc oficial (`developers.facebook.com/documentation/instagram-platform/
 * instagram-api-with-instagram-login/business-login`) manda o token de
 * `refresh_access_token` como parâmetro `access_token` na QUERY, diferente do
 * resto da Graph API deste arquivo-irmão (`graph.ts`), que usa
 * `Authorization: Bearer`. A URL nunca é logada — ela carrega o token — só o
 * status da resposta.
 *
 * ─── O aviso REUSA o helper do vigia de saúde, não copia ───────────────────
 *
 * `sincronizarSaudeDaConexao` (`lib/channels/health.ts`) já sabe escalar UMA
 * vez por episódio e resolver quando a próxima observação vem boa — é o
 * mesmo mecanismo que o cron `channel-health` usa. Esta rotina chama essa
 * MESMA função, com origem `renovacao`: falha de renovação vira uma
 * `SaudeObservada` com `detail: DETALHE_TOKEN_DE_RENOVACAO_VENCIDO` (episódio
 * próprio, que a varredura de saúde não fecha nem duplica); sucesso vira uma
 * observação "sem problema", que resolve o aviso se havia um aberto. Duplicar esse select→insert→upsert aqui seria o
 * mesmo defeito que a doutrina do repo chama de "duplicação sem source of
 * truth declarado" — um segundo lugar para divergir do primeiro no dia em
 * que o contrato de `agent_inbox_items` mudar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { DETALHE_TOKEN_DE_RENOVACAO_VENCIDO, sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_INSTAGRAM } from "../capabilities";
import { BASE_DO_INSTAGRAM } from "./graph";
import { juntarDuplicadosPorArroba } from "./juntar-por-arroba";
import { deveBuscarPerfil, nomeAtualDoContato, preencherPerfilDoContato } from "./perfil-do-contato";

/** Teto de grupos de mesmo @ juntados por organização, por rodada. */
const TETO_DE_JUNCOES_POR_ORGANIZACAO = 50;

/** Renova quando faltam menos de 15 dias — folga contra uma rodada perdida. */
const JANELA_DE_RENOVACAO_MS = 15 * 24 * 60 * 60 * 1000;

/** Teto por rodada: renovar centenas de contas num tick estouraria a cota da Meta. */
const TETO_POR_RODADA = 50;

/** Teto de contatos sem nome preenchidos por sessão, por rodada. */
const TETO_DE_NOMES_POR_SESSAO = 50;

export function precisaRenovar(expiraEm: Date, agora: Date): boolean {
  return expiraEm.getTime() - agora.getTime() < JANELA_DE_RENOVACAO_MS;
}

export interface SessaoParaRenovar {
  id: string;
  organization_id: string;
  ig_username: string | null;
  ig_token_encrypted: string;
}

/** As sessões `meta_instagram` ativas com token a vencer dentro da janela. */
export async function sessoesParaRenovar(
  admin: SupabaseClient,
  agora: Date,
): Promise<SessaoParaRenovar[]> {
  const limite = new Date(agora.getTime() + JANELA_DE_RENOVACAO_MS).toISOString();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_username, ig_token_encrypted")
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .not("ig_token_encrypted", "is", null)
    .lte("ig_token_expires_at", limite)
    .limit(TETO_POR_RODADA);
  if (error || !data) return [];
  return data as SessaoParaRenovar[];
}

/**
 * As sessões `meta_instagram` ativas cujo token ainda vale: a passada diária
 * dos nomes roda em TODAS, não só nas que renovaram (essas renovam a cada ~45
 * dias, e o nome esperaria isso tudo).
 *
 * Mesmo teto da renovação: o laço que consome é sequencial, com até
 * `TETO_DE_NOMES_POR_SESSAO` chamadas à Graph por sessão e 15s de timeout em
 * cada — sem teto, 40 contas com a Graph lenta são 40 × 50 × 15s num tick só.
 * ponytail: acima de 50 contas numa instalação, as demais ficam sem a passada;
 * quando existir, ordenar por "última passada" como a fila de contatos faz.
 */
async function sessoesComTokenUtilizavel(
  admin: SupabaseClient,
  agora: Date,
): Promise<SessaoParaRenovar[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_username, ig_token_encrypted")
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .not("ig_token_encrypted", "is", null)
    .gt("ig_token_expires_at", agora.toISOString())
    .limit(TETO_POR_RODADA);
  if (error || !data) return [];
  return data as SessaoParaRenovar[];
}

export interface TokenRenovado {
  token: string;
  expiraEm: Date;
}

/**
 * GET `refresh_access_token` — token em claro, nunca logado (nem na URL).
 * `null` em qualquer falha (rede, resposta não-ok, corpo sem os campos
 * esperados): o chamador decide o que fazer, nunca lança.
 */
export async function renovarToken(tokenAtual: string): Promise<TokenRenovado | null> {
  const url = `${BASE_DO_INSTAGRAM}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tokenAtual)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logger.info("[instagram.renovacao] recusada", { status: res.status });
      return null;
    }
    const corpo = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!corpo.access_token || !corpo.expires_in) return null;
    return { token: corpo.access_token, expiraEm: new Date(Date.now() + corpo.expires_in * 1000) };
  } catch (err) {
    logger.info("[instagram.renovacao] falhou", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Grava o token novo cifrado e a validade nova — sempre filtrado pela organização. */
export async function gravarTokenRenovado(
  admin: SupabaseClient,
  sessao: Pick<SessaoParaRenovar, "id" | "organization_id">,
  tokenCifrado: string,
  expiraEm: Date,
): Promise<void> {
  await admin
    .from("channel_sessions")
    .update({ ig_token_encrypted: tokenCifrado, ig_token_expires_at: expiraEm.toISOString() })
    .eq("id", sessao.id)
    .eq("organization_id", sessao.organization_id);
}

/** "Instagram @conta" — ou "Instagram sem nome" se a conta nunca gravou o handle. */
function apelidoDaSessao(sessao: SessaoParaRenovar): string {
  return `Instagram ${sessao.ig_username ? `@${sessao.ig_username}` : "sem nome"}`;
}

interface ConversaSemNome {
  contact_id: string;
  provider_conversation_id: string;
  contacts: { display_name: string | null; source_metadata: Record<string, unknown> } | null;
}

/**
 * Até `TETO_DE_NOMES_POR_SESSAO` contatos sem nome desta sessão, preenchidos
 * com o token que acabou de renovar (válido em mãos). Mesma regra de
 * `deveBuscarPerfil` que a ingestão usa — aqui sempre com `identidadeNova:
 * false` (a rodada só olha contato já existente).
 *
 * A fila GIRA na consulta: nunca tentados primeiro, depois do tentado há mais
 * tempo. Sem isso o `limit` devolvia sempre as mesmas 50 linhas — com 80
 * contatos sem nome público, os 50 primeiros voltavam a ser elegíveis a cada
 * 24h e ocupavam as vagas de novo; do 51º em diante ninguém era alcançado.
 */
async function preencherNomesDaSessao(
  admin: SupabaseClient,
  sessao: Pick<SessaoParaRenovar, "id" | "organization_id">,
  token: string,
  agora: Date,
): Promise<number> {
  const { data, error } = await admin
    .from("conversations")
    .select("contact_id, provider_conversation_id, contacts:contact_id!inner(display_name, source_metadata)")
    .eq("organization_id", sessao.organization_id)
    .eq("channel_session_id", sessao.id)
    .not("provider_conversation_id", "is", null)
    .is("contacts.display_name", null)
    // Ordena o PAI pela coluna JSON do contato embutido (`order=contacts(...)`,
    // relação to-one) — `referencedTable` ordenaria só as linhas embutidas.
    .order("contacts(source_metadata->>perfil_tentado_em)", { nullsFirst: true })
    .limit(TETO_DE_NOMES_POR_SESSAO);
  if (error) {
    logger.warn("[instagram.renovacao] ler conversas sem nome falhou", {
      sessionId: sessao.id,
      detail: error.message,
    });
    return 0;
  }

  let preenchidos = 0;
  for (const linha of (data ?? []) as unknown as ConversaSemNome[]) {
    const tentadoEm = (linha.contacts?.source_metadata?.perfil_tentado_em as string | undefined) ?? null;
    if (!deveBuscarPerfil({ identidadeNova: false, nomeAtual: nomeAtualDoContato(linha.contacts), tentadoEm, agora })) continue;
    const resultado = await preencherPerfilDoContato(admin, {
      organizationId: sessao.organization_id,
      contactId: linha.contact_id,
      igsid: linha.provider_conversation_id,
      token,
      agora,
    });
    if (resultado === "preenchido") preenchidos += 1;
  }
  return preenchidos;
}

export interface ResumoDaRenovacao {
  examinadas: number;
  renovadas: number;
  falhas: number;
  nomesPreenchidos: number;
  contatosJuntados: number;
}

/** As organizações com sessão `meta_instagram` ativa (não arquivada) — não precisa de token: a junção por @ nunca chama a Graph. */
async function organizacoesComInstagramAtivo(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("organization_id")
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null);
  if (error || !data) return [];
  return [...new Set((data as { organization_id: string }[]).map((s) => s.organization_id))];
}

/**
 * A rodada inteira: examina, renova, grava, avisa (ou resolve) — e só audita
 * quando renovou alguma coisa. Cada sessão é tratada sozinha: uma falha não
 * derruba as outras.
 */
export async function renovarTokensDoInstagram(
  admin: SupabaseClient,
  agora: Date,
): Promise<ResumoDaRenovacao> {
  const resumo: ResumoDaRenovacao = { examinadas: 0, renovadas: 0, falhas: 0, nomesPreenchidos: 0, contatosJuntados: 0 };
  const sessoes = await sessoesParaRenovar(admin, agora);
  // Token que acabou de renovar já está em claro: a passada dos nomes o reusa.
  const tokensEmMaos = new Map<string, string>();

  for (const sessao of sessoes) {
    resumo.examinadas += 1;
    const alvo = {
      id: sessao.id,
      organization_id: sessao.organization_id,
      status: null,
      provider: CHANNEL_PROVIDER_INSTAGRAM,
    };
    const apelido = apelidoDaSessao(sessao);
    try {
      const tokenAtual = await decryptWebhookSecret(admin, sessao.ig_token_encrypted);
      const renovado = tokenAtual ? await renovarToken(tokenAtual) : null;
      if (!renovado) {
        resumo.falhas += 1;
        await sincronizarSaudeDaConexao(
          admin,
          alvo,
          { reachable: false, status: null, detail: DETALHE_TOKEN_DE_RENOVACAO_VENCIDO },
          apelido,
          "renovacao",
        );
        continue;
      }

      const cifrado = await encryptWebhookSecret(admin, renovado.token);
      if (!cifrado) {
        resumo.falhas += 1;
        await sincronizarSaudeDaConexao(
          admin,
          alvo,
          { reachable: false, status: null, detail: DETALHE_TOKEN_DE_RENOVACAO_VENCIDO },
          apelido,
          "renovacao",
        );
        continue;
      }

      await gravarTokenRenovado(admin, sessao, cifrado, renovado.expiraEm);
      // Observação "sem problema": resolve o aviso se havia um aberto por esta
      // MESMA rotina; não mexe num aviso que a sonda de saúde abriu por outro
      // motivo (`sincronizarSaudeDaConexao` só fecha o episódio que casa).
      await sincronizarSaudeDaConexao(admin, alvo, { reachable: true, status: null, detail: null }, apelido, "renovacao");
      resumo.renovadas += 1;
      tokensEmMaos.set(sessao.id, renovado.token);
    } catch (err) {
      logger.warn("[instagram.renovacao] falhou numa sessão", {
        sessionId: sessao.id,
        detail: err instanceof Error ? err.message : "erro",
      });
      resumo.falhas += 1;
    }
  }

  // Toda sessão com token válido preenche quem ainda ficou sem nome (o eco
  // que chegou como primeira mensagem, por exemplo: `perfil-do-contato.ts`).
  // Teto de 50 por sessão e throttle de 24h por contato seguem valendo.
  for (const sessao of await sessoesComTokenUtilizavel(admin, agora)) {
    try {
      const token = tokensEmMaos.get(sessao.id) ?? (await decryptWebhookSecret(admin, sessao.ig_token_encrypted));
      if (!token) continue;
      resumo.nomesPreenchidos += await preencherNomesDaSessao(admin, sessao, token, agora);
    } catch (err) {
      logger.warn("[instagram.renovacao] preencher nomes falhou numa sessão", {
        sessionId: sessao.id,
        detail: err instanceof Error ? err.message : "erro",
      });
    }
  }

  // Mesmo @ vira um contato só: por organização com sessão ativa, não só nas
  // que renovaram ou nas com token — a junção é local (handle já gravado),
  // nunca chama a Graph.
  for (const organizationId of await organizacoesComInstagramAtivo(admin)) {
    try {
      resumo.contatosJuntados += await juntarDuplicadosPorArroba(admin, organizationId, TETO_DE_JUNCOES_POR_ORGANIZACAO);
    } catch (err) {
      logger.warn("[instagram.renovacao] juntar por arroba falhou numa organização", {
        organization_id: organizationId,
        detail: err instanceof Error ? err.message : "erro",
      });
    }
  }

  // Só audita rodada que teve efeito — token renovado, nome preenchido OU
  // contato juntado; rodada vazia (ou só falhas) não é mutação
  // (tests/unit/cron-audita-so-quando-ha-efeito.test.ts).
  if (resumo.renovadas > 0 || resumo.nomesPreenchidos > 0 || resumo.contatosJuntados > 0) {
    await audit({
      action: "channel.instagram_token_refreshed",
      metadata: {
        examinadas: resumo.examinadas,
        renovadas: resumo.renovadas,
        falhas: resumo.falhas,
        nomes_preenchidos: resumo.nomesPreenchidos,
        contatos_juntados: resumo.contatosJuntados,
      },
    });
  }

  return resumo;
}
