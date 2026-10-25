/** Quem faz o quê no programa de bônus. Puro, para o teste fixar a regra. */
export function papelNoPrograma(
  p: { aprovadorUserId: string; regras: { participantes: string[] } },
  userId: string,
): { aprovador: boolean; participante: boolean } {
  return { aprovador: p.aprovadorUserId === userId, participante: p.regras.participantes.includes(userId) };
}

/** Sem programa ainda: só o dono da organização ou o platform admin pleno, fora do suporte. */
export function podeCriarPrograma(
  user: { id: string; is_platform_admin: boolean; platform_admin_scope?: string | null; support?: unknown },
  criadoPor: string | null,
): boolean {
  if (criadoPor !== null && user.id === criadoPor) return true;
  return user.is_platform_admin && user.platform_admin_scope === "full" && !user.support;
}

/** As chaves de topo que mudaram. A auditoria leva isto, nunca os valores. */
export function chavesAlteradas(antes: Record<string, unknown>, depois: Record<string, unknown>): string[] {
  const chaves = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  return [...chaves].filter((k) => JSON.stringify(antes[k]) !== JSON.stringify(depois[k])).sort();
}
