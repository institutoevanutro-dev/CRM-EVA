/**
 * Gravação da conexão do Instagram em `channel_sessions`. Toda escrita que
 * nomeia o provider mora aqui (as rotas em `app/` só chamam), por causa do
 * `lint:channels`.
 *
 * Sem `upsert onConflict`: o índice único `uniq_channel_sessions_ig_account_ativa`
 * é PARCIAL (`where ... archived_at is null`) e o PostgREST não consegue apontá-lo
 * como árbitro — a mesma razão do canal oficial (`app/api/v1/channels/official`).
 * Então: procura a linha ATIVA da conta na instalação inteira; de outra org →
 * recusa sem escrever; da mesma org → atualiza; nenhuma → insere. Um 23505 no
 * insert é corrida com outra aba conectando a mesma conta: relê e decide de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { roleAtLeast } from "@/lib/auth/types";
import { CHANNEL_PROVIDER_INSTAGRAM } from "../capabilities";
import { sincronizarSaudeDaConexao } from "../health";
import { sessaoDoInstagramPorConta } from "./sessao";

export interface ConexaoDoInstagram {
  organizationId: string;
  igAccountId: string;
  username: string;
  tokenCifrado: string;
  expiraEm: Date;
  userId: string;
}

export type ResultadoDaConexao = { status: "criada" | "atualizada" | "conta_em_outra_organizacao" };

/** A linha ATIVA da conta na instalação — reusa a raiz do roteamento do webhook. */
async function linhaAtiva(admin: SupabaseClient, igAccountId: string) {
  const r = await sessaoDoInstagramPorConta(admin, igAccountId);
  if (r.status === "erro") throw new Error(r.motivo);
  return r.status === "ok" ? { id: r.sessao.id, organization_id: r.sessao.organizationId } : null;
}

async function atualizar(admin: SupabaseClient, id: string, c: ConexaoDoInstagram): Promise<ResultadoDaConexao> {
  const { error } = await admin
    .from("channel_sessions")
    .update({
      status: "WORKING",
      ig_username: c.username,
      ig_token_encrypted: c.tokenCifrado,
      ig_token_expires_at: c.expiraEm.toISOString(),
      display_name: `@${c.username}`,
      last_status_change_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("organization_id", c.organizationId);
  if (error) throw new Error(error.message);
  // Reconectar TROCA a chave: fecha o aviso "precisa ser reconectado" (ou o
  // FAILED da sonda). Sem isto, o aviso da renovação ficaria aberto até a
  // próxima renovação, que com o token novo só roda daqui a 45 dias.
  await sincronizarSaudeDaConexao(
    admin,
    { id, organization_id: c.organizationId, status: "WORKING" },
    { reachable: true, status: "WORKING", detail: null },
    `Instagram @${c.username}`,
    "renovacao",
  );
  return { status: "atualizada" };
}

export async function salvarConexaoDoInstagram(admin: SupabaseClient, c: ConexaoDoInstagram): Promise<ResultadoDaConexao> {
  const existente = await linhaAtiva(admin, c.igAccountId);
  if (existente) {
    return existente.organization_id === c.organizationId
      ? atualizar(admin, existente.id, c)
      : { status: "conta_em_outra_organizacao" };
  }

  const { error } = await admin.from("channel_sessions").insert({
    organization_id: c.organizationId,
    provider: CHANNEL_PROVIDER_INSTAGRAM,
    status: "WORKING",
    ig_account_id: c.igAccountId,
    ig_username: c.username,
    ig_token_encrypted: c.tokenCifrado,
    ig_token_expires_at: c.expiraEm.toISOString(),
    display_name: `@${c.username}`,
    // NOT NULL herdado do WAHA. A assinatura do webhook é do APP, então aqui
    // vai o valor neutro da linha de voz (`voice/sessions/pair`), nunca o
    // token: a cópia não era renovada nem apagada e sobrevivia à desconexão.
    webhook_secret_encrypted: Buffer.from([0]),
    metadata: metadataInicialDoCanal(),
    created_by: c.userId,
  });
  if (!error) return { status: "criada" };
  if (error.code !== "23505") throw new Error(error.message);

  const vencedora = await linhaAtiva(admin, c.igAccountId);
  if (!vencedora) throw new Error(error.message);
  return vencedora.organization_id === c.organizationId
    ? atualizar(admin, vencedora.id, c)
    : { status: "conta_em_outra_organizacao" };
}

/**
 * Quem volta do consentimento ainda é manager+ na org do `state`? A volta vem
 * de outro site e o cookie de sessão (`SameSite=Strict`) não viaja — então o
 * papel é relido pelo admin client, a partir da identidade do `state` assinado.
 */
export async function podeConectarNaOrganizacao(admin: SupabaseClient, organizationId: string, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) return false;
  return roleAtLeast((data as { role?: string } | null)?.role, "manager");
}

// ─── Tela de Conexões: listar, desconectar, origem padrão ────────────────────
// Todas filtram `organization_id` recebido de quem chama, que o resolve da
// SESSÃO do usuário, nunca do corpo. O admin client ignora RLS.

export interface OrigemPadrao {
  campo: string;
  valor: string;
}

export interface ContaDoInstagram {
  id: string;
  username: string | null;
  status: string;
  expiraEm: string | null;
  origemPadrao: OrigemPadrao | null;
}

function origemDe(metadata: Record<string, unknown> | null): OrigemPadrao | null {
  const o = metadata?.origem_padrao as Partial<OrigemPadrao> | undefined;
  return o?.campo && o?.valor ? { campo: o.campo, valor: o.valor } : null;
}

export async function listarConexoesDoInstagram(db: SupabaseClient, organizationId: string): Promise<ContaDoInstagram[]> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, ig_username, status, ig_token_expires_at, metadata")
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  type Linha = { id: string; ig_username: string | null; status: string; ig_token_expires_at: string | null; metadata: Record<string, unknown> | null };
  return ((data ?? []) as Linha[]).map((l) => ({
    id: l.id,
    username: l.ig_username,
    status: l.status,
    expiraEm: l.ig_token_expires_at,
    origemPadrao: origemDe(l.metadata),
  }));
}

/** Arquiva a conexão ativa e apaga a chave. Devolve o @ para o audit, ou `null` se não há linha. */
export async function arquivarConexaoDoInstagram(admin: SupabaseClient, organizationId: string, sessionId: string): Promise<{ username: string | null } | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    // A chave vai junto: arquivar só esconde a linha, e um token de 60 dias
    // guardado numa conta "desconectada" é acesso vivo sem dono na tela.
    .update({ archived_at: new Date().toISOString(), ig_token_encrypted: null, ig_token_expires_at: null })
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .select("ig_username")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { username: (data as { ig_username: string | null }).ig_username } : null;
}

/** Grava (ou limpa, com `null`) `metadata.origem_padrao`, mesclando o resto do metadata. */
export async function definirOrigemPadrao(admin: SupabaseClient, organizationId: string, sessionId: string, origem: OrigemPadrao | null): Promise<boolean> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("id", sessionId)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_INSTAGRAM)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  const { origem_padrao: _antiga, ...resto } = ((data as { metadata: Record<string, unknown> | null }).metadata ?? {});
  void _antiga;
  const { error: erroUpdate } = await admin
    .from("channel_sessions")
    .update({ metadata: origem ? { ...resto, origem_padrao: origem } : resto })
    .eq("id", sessionId)
    .eq("organization_id", organizationId);
  if (erroUpdate) throw new Error(erroUpdate.message);
  return true;
}
