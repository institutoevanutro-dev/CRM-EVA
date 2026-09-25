/**
 * GET /api/v1/channels/instagram: o que o cartão do Instagram em Conexões mostra:
 * se a instalação pode conectar (credencial do app), as contas ativas da org e
 * os campos `select` do funil padrão (para a Origem padrão).
 *
 * A org vem da sessão; as consultas que nomeiam o canal moram em `lib/channels/instagram`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { appDoInstagram, instagramPodeConectar } from "@/lib/channels/instagram/app";
import { listarConexoesDoInstagram } from "@/lib/channels/instagram/conexao";
import { camposDeListaDoFunilPadrao } from "@/lib/leads/campos-do-funil";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  try {
    const [app, contas, campos] = await Promise.all([
      appDoInstagram(),
      listarConexoesDoInstagram(admin, orgId),
      camposDeListaDoFunilPadrao(admin, orgId),
    ]);

    return ok(
      {
        pode_conectar: instagramPodeConectar(app),
        contas: contas.map((c) => ({
          id: c.id,
          username: c.username,
          status: c.status,
          expira_em: c.expiraEm,
          origem_padrao: c.origemPadrao,
        })),
        campos,
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Não foi possível carregar as contas do Instagram.", 500, { requestId });
  }
}
