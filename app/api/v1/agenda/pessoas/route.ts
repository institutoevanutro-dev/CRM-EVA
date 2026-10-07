/**
 * GET /api/v1/agenda/pessoas — quem tem agenda, para a barra de pessoas da Agenda.
 *
 * Porte de melgarafael/DeskcommCRM 297e7ff5a (issue #896, item 1), com o papel
 * Prestador deste fork.
 *
 * Exceção deliberada e MÍNIMA à matriz spec 13 §4 (team read = manager+), no
 * mesmo espírito de `/api/v1/team/assignable`: a recepção precisa ver de quem
 * é a agenda em que está marcando, e com `/api/v1/team` ela tomava 403 — a
 * barra vinha vazia e o painel dizia "Você" sobre a jornada da médica. Sai só o
 * irredutível: id, papel e nome. Sem e-mail, sem último acesso (gerente sem
 * `full_name` cadastrado recebe no nome a parte do e-mail antes do @).
 *
 * O Prestador (`provider`) lê a lista, mas recebe só a si mesmo: ele trabalha
 * só na própria agenda (a RLS de `calendar_appointments` esconde dele os
 * compromissos dos colegas). `viewer` segue sem a lista.
 *
 * A RLS de `user_organizations` só mostra o próprio membership abaixo de
 * gerente, por isso o client admin com filtro EXPLÍCITO de `organization_id`
 * vindo do cookie validado (`authz.org`), como manda a doutrina.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { isServiceRoleConfigured } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface PessoaDaAgenda {
  user_id: string;
  role: string;
  full_name: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("provider", { requestId, resource: "agenda" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId; // fonte confiável (cookie validado)

  const client = isServiceRoleConfigured() ? createAdminClient() : await createClient();
  let consulta = client
    .from("user_organizations")
    .select("user_id, role")
    .eq("organization_id", orgId);
  if (authz.org.role === "provider") consulta = consulta.eq("user_id", authz.user.id);
  // Revogado não tem agenda para mostrar hoje (diferente de `/api/v1/team`,
  // onde a linha revogada fica porque é de lá que se reativa alguém).
  const { data: rows, error } = await consulta
    .is("revoked_at", null)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const membros = (rows ?? []) as Array<{ user_id: string; role: string }>;
  if (!isServiceRoleConfigured() || membros.length === 0) {
    return ok(membros.map((m) => ({ ...m, full_name: null })), { requestId });
  }

  // Sem `full_name` (todo usuário criado pelo login EvaLink), o gerente vê a
  // parte do e-mail antes do @ — o que `/api/v1/team`, que ele já lê inteira,
  // dava a esta barra antes da lista mínima. Abaixo de gerente, nada de e-mail.
  const veEmail = roleAtLeast(authz.org.role, "manager");
  const admin = createAdminClient();
  const pessoas: PessoaDaAgenda[] = await Promise.all(
    membros.map(async (m) => {
      const { data: userRes } = await admin.auth.admin.getUserById(m.user_id);
      return {
        ...m,
        full_name:
          (userRes?.user?.user_metadata?.full_name as string | undefined) ??
          (veEmail ? userRes?.user?.email?.split("@")[0] : undefined) ??
          null,
      };
    }),
  );
  return ok(pessoas, { requestId });
}
