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
    // NOT NULL herdado do WAHA; o canal oficial grava a cifra do token aqui, e
    // o Instagram segue o mesmo valor neutro (a assinatura do webhook é do APP).
    webhook_secret_encrypted: c.tokenCifrado,
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
