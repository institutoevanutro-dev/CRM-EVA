/**
 * Organização PARADA não dispara campanha.
 *
 * Porte do comportamento de `lib/organizacao/operante.ts` do DeskcommCRM
 * original (melgarafael, commits d4b23e4bd, de0bbe2f5 e 8565a99ff), recortado ao
 * que a campanha precisa. Lá ela é a "régua única" do produto inteiro; aqui não:
 * este fork ainda não tem essa régua, e um módulo com esse nome que só a
 * campanha usa prometeria uma cobertura que não existe. Por isso mora em
 * `lib/campanhas/`.
 *
 * Operante é `status = 'active'` e mais nada: suspensa, redigida ou arquivada
 * não fala com ninguém — disparo em massa é a última coisa que deveria
 * continuar saindo de uma conta parada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const STATUS_OPERANTE = "active" as const;

export function ehOperante(status: string | null | undefined): boolean {
  return status === STATUS_OPERANTE;
}

/** A organização parou entre a leitura da rodada e o envio. Não é culpa do destinatário. */
export class OrgNaoOperanteError extends Error {
  constructor(
    readonly organizationId: string,
    readonly orgStatus: string | null = null,
  ) {
    super("A conta desta empresa está suspensa.");
    this.name = "OrgNaoOperanteError";
  }
}

/** O status embutido por `organizations:organization_id!inner(status)` — objeto ou lista. */
export function statusDaOrgEmbutida(
  embutida: { status?: string | null } | Array<{ status?: string | null }> | null | undefined,
): string | null | undefined {
  if (!embutida) return undefined;
  return Array.isArray(embutida) ? embutida[0]?.status : embutida.status;
}

/**
 * Lança `OrgNaoOperanteError` se a organização não opera AGORA. Erro de leitura
 * lança a MESMA classe (com status `null`): sem saber o status não se envia, e
 * o destinatário volta à fila em vez de ser marcado como falha — falhar fechado
 * aqui só adia o envio para a próxima rodada.
 */
export async function assertOrgOperante(db: SupabaseClient, orgId: string): Promise<void> {
  const { data, error } = await db.from("organizations").select("status").eq("id", orgId).maybeSingle();
  if (error) throw new OrgNaoOperanteError(orgId, null);
  const status = (data as { status?: string } | null)?.status ?? null;
  if (!ehOperante(status)) throw new OrgNaoOperanteError(orgId, status);
}
