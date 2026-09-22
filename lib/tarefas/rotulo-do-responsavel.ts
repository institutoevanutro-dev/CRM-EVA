/**
 * O NOME DE QUEM FAZ A TAREFA, como a tela mostra.
 *
 * Nunca o id cru: quem lê a lista quer saber "é do Erick?", não um uuid. Os
 * textos saem em português e a tela os passa por `t()`.
 */
import type { AssignableMember } from "@/hooks/inbox/useAssignableMembers";

export function nomeDoResponsavel(
  membros: readonly AssignableMember[],
  userId: string | null | undefined,
): string | null {
  if (!userId) return null;
  const membro = membros.find((m) => m.user_id === userId);
  if (!membro) return "Fora da equipe";
  return membro.full_name?.trim() || "Sem nome";
}
