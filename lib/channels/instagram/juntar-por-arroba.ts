/**
 * Mesmo @ vira um contato só.
 *
 * Quem escreve para os dois perfis conectados da clínica no Instagram ganha
 * DOIS IGSIDs (um por perfil) e, hoje, dois contatos — cada um com sua própria
 * conversa. Quando as duas identidades de canal têm o MESMO handle (`@`,
 * comparado sem diferenciar maiúsculas), é a mesma pessoa: junta automático
 * pela MESMA `fn_mesclar_contatos` que a rota de merge manual usa
 * (`app/api/v1/contacts/merge/route.ts`), com service role — a função aceita
 * sem `auth.uid()` (o path de sistema já pode chamá-la, desde que resolva
 * `organization_id` de fonte confiável, nunca do body; aqui vem do caller).
 *
 * O @ gravado só ACHA candidatos; o merge exige o @ VIVO de cada identidade
 * (ver `juntarPorArroba`). Best-effort sempre: erro aqui nunca pode impedir a
 * ingestão de uma mensagem nem a passada diária de renovação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_INSTAGRAM } from "../capabilities";
import { perfilDoRemetente } from "./graph";

/** Escapa `%`, `_` e `\` antes de um `.ilike` — os três têm sentido especial no PostgREST. */
function escaparParaIlike(valor: string): string {
  return valor.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Entre contatos vivos (não absorvidos) de mesmo @: o principal é o de
 * `created_at` mais antigo; empate desempata pelo menor `id` — determinístico,
 * nunca depende da ordem de chegada da consulta.
 */
export function escolherPrincipal(
  contatos: { id: string; created_at: string }[],
): { principal: string; secundarios: string[] } | null {
  if (contatos.length < 2) return null;
  const ordenados = [...contatos].sort((a, b) => {
    const diferenca = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (diferenca !== 0) return diferenca;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const [principal, ...secundarios] = ordenados;
  return { principal: principal!.id, secundarios: secundarios.map((c) => c.id) };
}

/**
 * Resultado de `juntarPorArroba`: quando junta, devolve o `principal` — o
 * caller nunca precisa reler `is_merged_into` para saber se o contato que
 * passou virou lápide (e, se virou, para qual id seguir).
 */
export type ResultadoDaJuncao = { juntou: true; principal: string } | { juntou: false };

const NADA: ResultadoDaJuncao = { juntou: false };

type IdentidadeGravada = { contact_id: string; external_id: string; handle: string | null };

/**
 * Token da sessão que conversa com este IGSID: identidade → conversa
 * (`provider_conversation_id` = IGSID) → `channel_sessions` ativa → decifra.
 * `null` quando não há conversa, sessão ativa, token ou a decifra falha.
 * `cache` evita decifrar o mesmo token duas vezes na mesma junção.
 */
async function tokenDoIgsid(
  admin: SupabaseClient,
  organizationId: string,
  igsid: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const { data: conversas, error } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("provider_conversation_id", igsid)
    .not("channel_session_id", "is", null);
  if (error) return null;
  const idsDeSessao = [
    ...new Set(((conversas as { channel_session_id: string }[] | null) ?? []).map((c) => c.channel_session_id)),
  ];
  if (idsDeSessao.length === 0) return null;
  const { data: sessoes, error: erroSessao } = await admin
    .from("channel_sessions")
    .select("id, ig_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .in("id", idsDeSessao)
    .is("archived_at", null)
    .not("ig_token_encrypted", "is", null)
    .limit(1);
  if (erroSessao) return null;
  const sessao = (sessoes as { id: string; ig_token_encrypted: string }[] | null)?.[0];
  if (!sessao) return null;
  if (!cache.has(sessao.id)) cache.set(sessao.id, await decryptWebhookSecret(admin, sessao.ig_token_encrypted));
  return cache.get(sessao.id) ?? null;
}

/**
 * @ VIVO desta identidade, perguntado à Graph agora — e gravado quando mudou
 * (um @ trocado ou reciclado não pode ficar no banco para a próxima rodada).
 * `null` = sem token, Graph falhou ou conta sem @: quem chama NÃO junta.
 */
async function handleVivo(
  admin: SupabaseClient,
  organizationId: string,
  identidade: IdentidadeGravada,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const token = await tokenDoIgsid(admin, organizationId, identidade.external_id, cache);
  if (!token) return null;
  const { handle } = await perfilDoRemetente(token, identidade.external_id);
  if (handle && handle !== identidade.handle) {
    await admin
      .from("contact_channel_identities")
      .update({ handle })
      .eq("organization_id", organizationId)
      .eq("channel", "instagram")
      .eq("external_id", identidade.external_id);
  }
  return handle;
}

/**
 * Junta `contactId` ao(s) contato(s) de mesmo @ (Instagram, case-insensitive).
 *
 * O merge é IRREVERSÍVEL, e o @ gravado pode estar velho: a pessoa troca de @
 * e outra pessoa pode passar a usar o antigo. Por isso o @ gravado só serve
 * para ACHAR candidatos; antes de fundir, o @ de TODA identidade envolvida
 * (a do próprio contato e a de cada candidato) é perguntado de novo à Graph,
 * com o token da sessão que conversa com aquele IGSID, e só entra no merge o
 * candidato cujo @ vivo ainda é igual ao vivo do próprio contato. Qualquer
 * dúvida (sem token, Graph falhou) = aquele candidato fica de fora.
 *
 * `{ juntou: false }` quando não há @, candidato verificado, contato vivo, ou
 * alguma leitura/o `rpc` falha — nunca lança.
 */
export async function juntarPorArroba(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<ResultadoDaJuncao> {
  try {
    // `.limit(1)`, não `.maybeSingle()`: depois de UM merge, o principal já
    // fica com 2+ linhas em `contact_channel_identities` (uma por IGSID
    // absorvido). `.maybeSingle()` erra com "mais de uma linha" nesse caso.
    // Qualquer uma serve de referência: todas foram verificadas vivas quando
    // vieram parar no mesmo contato.
    const { data: identidadesProprias, error: erroIdentidadePropria } = await admin
      .from("contact_channel_identities")
      .select("contact_id, external_id, handle")
      .eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId)
      .eq("channel", "instagram")
      .not("handle", "is", null)
      .limit(1);
    if (erroIdentidadePropria) {
      logger.warn("[instagram.juntar-por-arroba] ler o handle do contato falhou", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        detail: erroIdentidadePropria.message,
      });
      return NADA;
    }
    const propria = (identidadesProprias as IdentidadeGravada[] | null)?.[0];
    if (!propria?.handle) return NADA;

    const cache = new Map<string, string | null>();
    const handleDeReferencia = await handleVivo(admin, input.organizationId, propria, cache);
    if (!handleDeReferencia) {
      logger.info("[instagram.juntar-por-arroba] @ vivo do contato indisponível; não junta", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
      });
      return NADA;
    }
    const referencia = handleDeReferencia.toLowerCase();

    const { data: outrasIdentidades } = await admin
      .from("contact_channel_identities")
      .select("contact_id, external_id, handle")
      .eq("organization_id", input.organizationId)
      .eq("channel", "instagram")
      .ilike("handle", escaparParaIlike(handleDeReferencia))
      .neq("contact_id", input.contactId);
    const candidatas = (outrasIdentidades as IdentidadeGravada[] | null) ?? [];
    const idsCandidatos = [...new Set(candidatas.map((i) => i.contact_id))];
    if (idsCandidatos.length === 0) return NADA;

    const { data: contatosVivos } = await admin
      .from("contacts")
      .select("id, created_at")
      .eq("organization_id", input.organizationId)
      .in("id", [input.contactId, ...idsCandidatos])
      .is("is_merged_into", null);
    const vivos = (contatosVivos as { id: string; created_at: string }[] | null) ?? [];

    // Um candidato entra só se TODAS as suas identidades de mesmo @ gravado
    // ainda são, ao vivo, o @ de referência.
    const verificados = new Set<string>();
    for (const candidato of vivos) {
      if (candidato.id === input.contactId) continue;
      let confere = true;
      for (const identidade of candidatas.filter((i) => i.contact_id === candidato.id)) {
        const vivo = await handleVivo(admin, input.organizationId, identidade, cache);
        if (vivo?.toLowerCase() !== referencia) {
          confere = false;
          logger.info("[instagram.juntar-por-arroba] candidato fora: @ vivo não confere ou indisponível", {
            organization_id: input.organizationId,
            contact_id: input.contactId,
            candidato_id: candidato.id,
            indisponivel: vivo === null,
          });
          break;
        }
      }
      if (confere) verificados.add(candidato.id);
    }

    const escolha = escolherPrincipal(vivos.filter((c) => c.id === input.contactId || verificados.has(c.id)));
    if (!escolha) return NADA;
    const principalId = escolha.principal;

    const { error: erroRpc } = await admin.rpc("fn_mesclar_contatos", {
      p_organization_id: input.organizationId,
      p_contato_principal: principalId,
      p_contatos_secundarios: escolha.secundarios,
    });
    if (erroRpc) {
      logger.warn("[instagram.juntar-por-arroba] fn_mesclar_contatos falhou", {
        organization_id: input.organizationId,
        detail: erroRpc.message,
      });
      return NADA;
    }

    await audit({
      action: "contact.merged",
      actorUserId: null,
      organizationId: input.organizationId,
      resourceType: "contact",
      resourceId: principalId,
      metadata: { merged_contact_ids: escolha.secundarios, motivo: "mesmo_arroba_instagram" },
    });

    return { juntou: true, principal: principalId };
  } catch (err) {
    logger.warn("[instagram.juntar-por-arroba] falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NADA;
  }
}

/**
 * Passada da rodada diária: agrupa por `lower(handle)` em memória (sem
 * `group by` no Postgres — o Instagram não guarda o handle em minúsculas de
 * propósito, é o displayed handle) e junta o contato mais novo de cada grupo
 * com 2+ contatos vivos, até `limite` grupos. `juntarPorArroba` decide o
 * principal de novo (pode não ser o "mais novo" chamado aqui) — chamar por
 * ele só evita reprocessar um contato que já é principal de outro grupo — e
 * passa pela MESMA verificação do @ vivo na Graph antes de fundir.
 */
export async function juntarDuplicadosPorArroba(
  admin: SupabaseClient,
  organizationId: string,
  limite: number,
): Promise<number> {
  const { data: identidades, error } = await admin
    .from("contact_channel_identities")
    .select("contact_id, handle")
    .eq("organization_id", organizationId)
    .eq("channel", "instagram")
    .not("handle", "is", null);
  if (error || !identidades) return 0;

  const porHandle = new Map<string, Set<string>>();
  for (const linha of identidades as { contact_id: string; handle: string }[]) {
    const chave = linha.handle.toLowerCase();
    const grupo = porHandle.get(chave) ?? new Set<string>();
    grupo.add(linha.contact_id);
    porHandle.set(chave, grupo);
  }
  const grupos = [...porHandle.values()].filter((g) => g.size >= 2).slice(0, limite);
  if (grupos.length === 0) return 0;

  const todosOsIds = [...new Set(grupos.flatMap((g) => [...g]))];
  const { data: contatos } = await admin
    .from("contacts")
    .select("id, created_at")
    .eq("organization_id", organizationId)
    .in("id", todosOsIds)
    .is("is_merged_into", null);
  const criadoEm = new Map(((contatos as { id: string; created_at: string }[] | null) ?? []).map((c) => [c.id, c.created_at]));

  let total = 0;
  for (const grupo of grupos) {
    const vivos = [...grupo].filter((id) => criadoEm.has(id));
    if (vivos.length < 2) continue;
    const maisNovo = vivos.reduce((novo, atual) => (criadoEm.get(atual)! > criadoEm.get(novo)! ? atual : novo));
    const resultado = await juntarPorArroba(admin, { organizationId, contactId: maisNovo });
    if (resultado.juntou) total += 1;
  }
  return total;
}
