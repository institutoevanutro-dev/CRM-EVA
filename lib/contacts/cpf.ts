/**
 * CPF normalization, hashing and at-rest encryption.
 *
 * O CPF de um contato é um PAR: `cpf_hash` (HMAC-SHA256 hex dos 11 dígitos com a
 * chave da instalação, pela RPC `cpf_indice`, migration 0289 — busca exata e
 * dedupe sem expor o número; um sha256 sem chave se revertia inteiro numa GPU)
 * e `cpf_encrypted` (bytea, pgp_sym AES-256 pela RPC `encrypt_cpf`, migration 0274). A constraint
 * `contacts_cpf_consistency` exige os dois nulos ou os dois preenchidos — por
 * isso quem grava CPF usa `parDoCpf()`, que devolve o par inteiro ou nada.
 * Gravar o hash sozinho foi o que derrubou 483 de 500 linhas de um import em
 * produção (22/09/2026).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Índice estável do CPF (HMAC com a chave da instalação) para busca exata em
 * `cpf_hash`. Só a service role calcula: sem a chave não há como reverter nem
 * forjar o índice, e é isso que faz a coluna não valer um CPF. `null` quando a
 * RPC não responde (função ausente, chave ausente).
 */
export async function indiceDoCpf(admin: SupabaseClient, raw: string): Promise<string | null> {
  const { data, error } = await admin.rpc("cpf_indice", { p_plaintext: normalizeCpf(raw) });
  if (error || typeof data !== "string" || data === "") {
    logger.warn("[contacts.cpf] cpf_indice falhou", { error: error?.message ?? "resposta vazia" });
    return null;
  }
  return data;
}

/** As duas colunas que a constraint amarra — sempre juntas. */
export interface ParDoCpf {
  cpf_hash: string;
  /** bytea no formato hex do PostgREST (`\x…`). */
  cpf_encrypted: string;
}

/**
 * Cifra o CPF e devolve o par pronto para o insert/update, ou `null` quando a
 * cifra não está disponível (função ausente, chave da instalação ausente). Com
 * `null` o chamador NÃO grava CPF nenhum e avisa quem pediu.
 *
 * `admin` é o client de service role: `encrypt_cpf` só é executável por ele. A
 * função não recebe organização nem lê linha — é cifra pura —, então não há
 * filtro de tenant a aplicar aqui.
 */
export async function parDoCpf(admin: SupabaseClient, raw: string): Promise<ParDoCpf | null> {
  const digitos = normalizeCpf(raw);
  const { data, error } = await admin.rpc("encrypt_cpf", { p_plaintext: digitos });
  if (error || typeof data !== "string" || data === "") {
    logger.warn("[contacts.cpf] encrypt_cpf falhou — CPF não será gravado", {
      error: error?.message ?? "resposta vazia",
    });
    return null;
  }
  const indice = await indiceDoCpf(admin, digitos);
  if (!indice) return null;
  return { cpf_hash: indice, cpf_encrypted: data };
}

/** Texto do aviso/erro quando a cifra está fora do ar (vai pelo dicionário). */
export const MSG_CPF_SEM_CIFRA =
  "CPF não foi gravado: a proteção de CPF desta instalação não está disponível. Peça ao administrador para rodar a atualização.";

/**
 * A máscara com que um CPF aparece fora da ficha (fila de proposta, aviso):
 * só os 2 dígitos verificadores. É a forma que a constraint
 * `contact_field_proposals_cpf_cifrado` (migration 0407) exige do
 * `valor_proposto` — no máximo 2 dígitos.
 */
export function mascararCpf(raw: string): string {
  return `•••.•••.•••-${normalizeCpf(raw).slice(-2)}`;
}

/**
 * O mesmo texto com todo CPF trocado pela máscara — para o `trecho` de uma
 * proposta, que a tela mostra a quem confere. Pega a forma com pontuação e a
 * de 11 dígitos colados (pode mascarar um telefone de 11 dígitos junto, e
 * mascarar demais é o lado certo do erro aqui).
 */
export function mascararCpfsNoTexto(texto: string): string {
  return texto.replace(/(?<!\d)\d{3}\.?\d{3}\.?\d{3}[-.\s]?\d{2}(?!\d)/g, (m) => mascararCpf(m));
}
