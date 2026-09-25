/**
 * Nome do contato do Instagram: quando buscar de novo, e como preencher.
 *
 * Medido em produção: 3 de 6 contatos do Instagram ficavam com "Contato do
 * Instagram" porque o primeiro evento deles era um ECO (resposta mandada pelo
 * celular) — e o perfil só era buscado quando a identidade ainda não
 * existia, então nunca mais depois. Este módulo troca "só na primeira vez"
 * por "enquanto o contato ficar sem nome, no máximo 1×/24h" — identidade
 * nova sempre busca (primeira chance); depois disso, só se ainda não tem
 * nome, e respeitando o intervalo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { perfilDoRemetente } from "./graph";

export const INTERVALO_ENTRE_TENTATIVAS_MS = 24 * 60 * 60 * 1000;

/** Deve buscar o perfil agora? Identidade nova sempre; contato sem nome, no máximo 1×/24h. */
export function deveBuscarPerfil(input: {
  identidadeNova: boolean;
  nomeAtual: string | null;
  tentadoEm: string | null;
  agora: Date;
}): boolean {
  if (input.identidadeNova) return true;
  if (input.nomeAtual) return false;
  if (!input.tentadoEm) return true;
  return input.agora.getTime() - new Date(input.tentadoEm).getTime() >= INTERVALO_ENTRE_TENTATIVAS_MS;
}

async function atualizarIdentidade(
  admin: SupabaseClient,
  input: { organizationId: string; igsid: string },
  perfil: { nome: string | null; handle: string | null; foto: string | null },
): Promise<void> {
  const { data } = await admin
    .from("contact_channel_identities")
    .select("handle, display_name, avatar_url")
    .eq("organization_id", input.organizationId)
    .eq("channel", "instagram")
    .eq("external_id", input.igsid)
    .maybeSingle();
  const atual = data as { handle: string | null; display_name: string | null; avatar_url: string | null } | null;
  if (!atual) return;
  const patch: Record<string, string> = {};
  if (!atual.handle && perfil.handle) patch.handle = perfil.handle;
  if (!atual.display_name && perfil.nome) patch.display_name = perfil.nome;
  if (!atual.avatar_url && perfil.foto) patch.avatar_url = perfil.foto;
  if (Object.keys(patch).length === 0) return;
  await admin
    .from("contact_channel_identities")
    .update(patch)
    .eq("organization_id", input.organizationId)
    .eq("channel", "instagram")
    .eq("external_id", input.igsid);
}

/**
 * Busca o perfil e preenche SÓ o que está vazio em `contacts`
 * (`display_name` ← nome ?? @handle; `source_metadata.handle`), e marca
 * `perfil_tentado_em`. Best-effort: nunca lança.
 */
export async function preencherPerfilDoContato(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; igsid: string; token: string; agora: Date },
): Promise<"preenchido" | "sem_perfil"> {
  try {
    const perfil = await perfilDoRemetente(input.token, input.igsid);

    const { data: contatoAtual } = await admin
      .from("contacts")
      .select("source_metadata")
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId)
      .maybeSingle();
    const metaAtual = ((contatoAtual as { source_metadata: Record<string, unknown> } | null)?.source_metadata ?? {}) as Record<
      string,
      unknown
    >;
    const novaMeta: Record<string, unknown> = { ...metaAtual, perfil_tentado_em: input.agora.toISOString() };
    if (!metaAtual.handle && perfil.handle) novaMeta.handle = perfil.handle;

    const nomeOuHandle = perfil.nome ?? (perfil.handle ? `@${perfil.handle}` : null);
    if (nomeOuHandle) {
      await admin
        .from("contacts")
        .update({ display_name: nomeOuHandle })
        .eq("organization_id", input.organizationId)
        .eq("id", input.contactId)
        .is("display_name", null);
    }
    await admin
      .from("contacts")
      .update({ source_metadata: novaMeta })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId);

    await atualizarIdentidade(admin, input, perfil);

    return nomeOuHandle ? "preenchido" : "sem_perfil";
  } catch (err) {
    logger.info("[instagram.perfil] preencherPerfilDoContato falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "sem_perfil";
  }
}
