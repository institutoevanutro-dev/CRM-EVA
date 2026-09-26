"use server";
import { cookies } from "next/headers";
import { z } from "zod";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export async function setActiveOrg(orgId: string): Promise<{ ok: boolean; error?: string }> {
  if (!z.string().uuid().safeParse(orgId).success) return { ok: false, error: "invalid_organization" };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (user.support) return { ok: false, error: "Encerre o acompanhamento antes de trocar de organização." };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };
  // Consulta fresca: não usa status de membership serializado no browser.
  const db = await createClient();
  const { data: membership, error } = await db.from("user_organizations")
    .select("organization_id, organizations!inner(status)")
    .eq("organization_id", orgId).eq("user_id", user.id)
    .is("revoked_at", null).not("accepted_at", "is", null)
    .eq("organizations.status", "active").maybeSingle();
  if (error || !membership) return { ok: false, error: "forbidden" };
  const store = await cookies();
  const previous = store.get("active_org")?.value;
  store.set("active_org", orgId, {
    httpOnly: true, sameSite: "strict", secure: cookieSecure(), path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  // A MESMA ESCOLHA, GRAVADA ONDE O LOGOUT NÃO ALCANÇA (migration 0282).
  //
  // O cookie acima resolve enquanto a sessão dura, e `signOut` o apaga de
  // propósito — cookie de organização não pode sobreviver a quem saiu do
  // navegador. Só que, sem ele, `loadAuthUser` caía no desempate por
  // `accepted_at` e reabria na organização aceita PRIMEIRO, ignorando toda
  // troca que a pessoa já tinha feito.
  //
  // Erro aqui NÃO derruba a ação: a troca já aconteceu (o cookie está escrito), e
  // falhar tudo por causa da preferência trocaria um incômodo pequeno — reabrir
  // na organização errada — por um grande: não conseguir trocar de organização.
  //
  // ⚠️ ADMIN CLIENT, e não o `db` do usuário, POR SEGURANÇA — não por preguiça.
  // A policy `user_orgs_update` exige `admin` da organização, então pelo client
  // do usuário um `agent` ou `viewer` não gravaria nada (e o PostgREST devolve
  // sucesso com zero linhas: falharia calado, justamente para quem mais tem uma
  // organização só de trabalho). Afrouxar a policy para `user_id = auth.uid()`
  // seria pior: a MESMA policy governa a coluna `role`, e quem pudesse escrever
  // a própria linha viraria `admin` sozinho. RLS não separa coluna aqui.
  //
  // O filtro que substitui a policy é manual e por fonte confiável, como manda
  // o CLAUDE.md: `user.id` vem do JWT validado por `loadAuthUser`, e `orgId`
  // acabou de ser confirmado como vínculo aceito e ativo na consulta acima.
  const { error: erroPreferencia } = await createAdminClient()
    .from("user_organizations")
    .update({ ultima_ativacao_em: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .is("revoked_at", null);
  if (erroPreferencia) {
    logger.warn("[setActiveOrg] preferência de organização não foi gravada", {
      organization_id: orgId,
      detail: erroPreferencia.message,
    });
  }
  await audit({ action: "organization.switched", actorUserId: user.id,
    organizationId: orgId, resourceType: "organization", resourceId: orgId,
    metadata: { previous_organization_id: z.string().uuid().safeParse(previous).success ? previous : null } });
  return { ok: true };
}
