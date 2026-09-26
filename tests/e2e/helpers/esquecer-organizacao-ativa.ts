/**
 * Apaga a organização que o seletor GRAVOU para um usuário do seed.
 *
 * Desde a migration 0282, `setActiveOrg` grava a escolha em
 * `user_organizations.ultima_ativacao_em`, e `loadAuthUser` reabre o próximo
 * login NELA — de propósito, o logout não apaga. Só que o `manager` do seed é
 * compartilhado pela suíte inteira: a spec que o troca para a org B deixava
 * TODA spec seguinte logando na org B, sem os tipos da agenda da org A.
 * Medido no CI em 2026-09-26: 11 casos da Agenda caindo em timeout na parte 2,
 * todos depois de `agenda-escopo-da-organizacao`.
 *
 * Quem troca de organização chama isto no `afterAll` e devolve o usuário ao
 * estado do seed (nunca trocou → desempate por `accepted_at`).
 */
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../../scripts/lib/env-de-teste";

export async function esquecerOrganizacaoAtiva(userId: string): Promise<void> {
  const c = credenciaisSupabaseDeTeste();
  const db = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
  const { error } = await db
    .from("user_organizations")
    .update({ ultima_ativacao_em: null })
    .eq("user_id", userId);
  if (error) throw new Error(`esquecerOrganizacaoAtiva: ${error.message}`);
}
