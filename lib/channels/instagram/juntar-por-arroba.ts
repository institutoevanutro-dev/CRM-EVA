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
 * Best-effort sempre: erro aqui nunca pode impedir a ingestão de uma
 * mensagem nem a passada diária de renovação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

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
 * Junta `contactId` ao(s) contato(s) de mesmo @ (Instagram, case-insensitive).
 * `"nada"` quando o contato não tem handle, não há outro contato com o mesmo
 * @, o(s) outro(s) já foram absorvidos, ou o `rpc` falha — nunca lança.
 */
export async function juntarPorArroba(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<"juntou" | "nada"> {
  try {
    const { data: identidadePropria } = await admin
      .from("contact_channel_identities")
      .select("handle")
      .eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId)
      .eq("channel", "instagram")
      .maybeSingle();
    const handle = (identidadePropria as { handle: string | null } | null)?.handle;
    if (!handle) return "nada";

    const { data: outrasIdentidades } = await admin
      .from("contact_channel_identities")
      .select("contact_id")
      .eq("organization_id", input.organizationId)
      .eq("channel", "instagram")
      .ilike("handle", escaparParaIlike(handle))
      .neq("contact_id", input.contactId);
    const idsCandidatos = [
      ...new Set(((outrasIdentidades as { contact_id: string }[] | null) ?? []).map((i) => i.contact_id)),
    ];
    if (idsCandidatos.length === 0) return "nada";

    const { data: contatosVivos } = await admin
      .from("contacts")
      .select("id, created_at")
      .eq("organization_id", input.organizationId)
      .in("id", [input.contactId, ...idsCandidatos])
      .is("is_merged_into", null);
    const escolha = escolherPrincipal((contatosVivos as { id: string; created_at: string }[] | null) ?? []);
    if (!escolha) return "nada";
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
      return "nada";
    }

    await audit({
      action: "contact.merged",
      actorUserId: null,
      organizationId: input.organizationId,
      resourceType: "contact",
      resourceId: principalId,
      metadata: { merged_contact_ids: escolha.secundarios, motivo: "mesmo_arroba_instagram" },
    });

    return "juntou";
  } catch (err) {
    logger.warn("[instagram.juntar-por-arroba] falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return "nada";
  }
}

/**
 * Passada da rodada diária: agrupa por `lower(handle)` em memória (sem
 * `group by` no Postgres — o Instagram não guarda o handle em minúsculas de
 * propósito, é o displayed handle) e junta o contato mais novo de cada grupo
 * com 2+ contatos vivos, até `limite` grupos. `juntarPorArroba` decide o
 * principal de novo (pode não ser o "mais novo" chamado aqui) — chamar por
 * ele só evita reprocessar um contato que já é principal de outro grupo.
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
    if (resultado === "juntou") total += 1;
  }
  return total;
}
