/**
 * CPF normalization, hashing and at-rest encryption.
 *
 * O CPF de um contato é um PAR: `cpf_hash` (sha256 hex dos 11 dígitos — busca
 * exata e dedupe sem expor o número) e `cpf_encrypted` (bytea, pgp_sym AES-256
 * pela RPC `encrypt_cpf`, migration 0274). A constraint
 * `contacts_cpf_consistency` exige os dois nulos ou os dois preenchidos — por
 * isso quem grava CPF usa `parDoCpf()`, que devolve o par inteiro ou nada.
 * Gravar o hash sozinho foi o que derrubou 483 de 500 linhas de um import em
 * produção (22/09/2026).
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized CPF for fuzzy/exact search via `cpf_hash`.
 */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
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
  return { cpf_hash: hashCpf(digitos), cpf_encrypted: data };
}

/** Texto do aviso/erro quando a cifra está fora do ar (vai pelo dicionário). */
export const MSG_CPF_SEM_CIFRA =
  "CPF não foi gravado: a proteção de CPF desta instalação não está disponível. Peça ao administrador para rodar a atualização.";
