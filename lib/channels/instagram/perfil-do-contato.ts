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

/** Quantas vezes o compare-and-set de `source_metadata` tenta antes de desistir. */
const TENTATIVAS_DE_MESCLA = 3;

/**
 * `display_name` de um registro, normalizado para `null` — nada além disso.
 * Não é a cadeia de apresentação (`nomeDoContato`/`rotuloDoContato` em
 * `lib/contacts/rotulo-do-contato.ts` decidem ENTRE `name`/`display_name`/
 * telefone para a tela); aqui só se pergunta "este registro já tem
 * `display_name`?", pra decidir se vale a pena buscar de novo.
 */
export function nomeAtualDoContato(registro: { display_name: string | null } | null | undefined): string | null {
  if (!registro) return null;
  if (registro.display_name) return registro.display_name;
  return null;
}

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
 * Mescla chaves em `contacts.source_metadata` sem apagar o que outro escritor
 * gravou no meio: lê, mescla e grava SÓ SE a coluna ainda é o que foi lido
 * (`eq` em jsonb compara por valor, não por texto — provado contra o PostgREST
 * 16.3); perdeu a corrida → relê e tenta de novo. Sem função no banco de
 * propósito. O PATCH de contatos (`app/api/v1/contacts/_handler.ts`) e a
 * reentrega do webhook escrevem esta MESMA coluna, e "ler, mesclar em memória,
 * gravar o objeto inteiro" era o que deixava um apagar a chave do outro —
 * inclusive o `perfil_tentado_em`, que é o throttle de 24h.
 * `false` = perdeu `TENTATIVAS_DE_MESCLA` vezes ou o contato não existe.
 */
async function mesclarMetadadosDoContato(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
  mesclar: (atual: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  for (let tentativa = 0; tentativa < TENTATIVAS_DE_MESCLA; tentativa += 1) {
    const { data: contato } = await admin
      .from("contacts")
      .select("source_metadata")
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId)
      .maybeSingle();
    if (!contato) return false;
    const atual = ((contato as { source_metadata: Record<string, unknown> | null }).source_metadata ?? {}) as Record<
      string,
      unknown
    >;
    const { data: gravados } = await admin
      .from("contacts")
      .update({ source_metadata: mesclar(atual) })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId)
      .eq("source_metadata", JSON.stringify(atual))
      .select("id");
    if (((gravados as unknown[] | null) ?? []).length > 0) return true;
  }
  return false;
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

    const nomeOuHandle = perfil.nome ?? (perfil.handle ? `@${perfil.handle}` : null);
    if (nomeOuHandle) {
      await admin
        .from("contacts")
        .update({ display_name: nomeOuHandle })
        .eq("organization_id", input.organizationId)
        .eq("id", input.contactId)
        .is("display_name", null);
    }
    const mesclou = await mesclarMetadadosDoContato(admin, input, (atual) => {
      const nova: Record<string, unknown> = { ...atual, perfil_tentado_em: input.agora.toISOString() };
      if (!atual.handle && perfil.handle) nova.handle = perfil.handle;
      return nova;
    });
    if (!mesclou) {
      logger.info("[instagram.perfil] source_metadata não gravado (corrida perdida ou contato ausente)", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
      });
    }

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
