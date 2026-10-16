/**
 * POST/DELETE /api/v1/leads/at-risk/recomeco — recomeçar o radar de risco a
 * partir de agora, ou desfazer o recomeço.
 *
 * Grava `organizations.settings.radar.desde` por `fn_definir_inicio_do_radar`
 * (migration 0370): o radar passa a ignorar negócio e demanda sem atividade
 * desde então. Nada é apagado; quem ganhar atividade nova volta. Lido por
 * `lib/leads/radar-de-risco.ts` (a tela, esta rota irmã e a capacidade da IA).
 *
 * Só ADMINISTRADOR: muda o que a equipe inteira vê como pendência. A escrita vai
 * pela chave de serviço porque a policy de escrita de `organizations` é só do
 * super-admin; a organização e o autor vêm da sessão, nunca do corpo, e a função
 * confere o papel de novo. Só audita quando mudou alguma coisa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O que a função devolve. Validado: é o corpo que a tela mostra. */
const resultadoSchema = z.object({
  desde: z.string().nullable(),
  antes: z.string().nullable(),
  mudou: z.boolean(),
});

async function definir(recomecar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "radar" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { data, error } = await createAdminClient().rpc("fn_definir_inicio_do_radar", {
    p_org: orgId,
    p_actor: authz.user.id,
    p_recomecar: recomecar,
  });
  if (error) {
    if (error.code === "42501") {
      return fail("forbidden_role", t("Só um administrador pode recomeçar o radar."), 403, { requestId });
    }
    return fail("internal_error", t("Não foi possível recomeçar o radar."), 500, { requestId });
  }
  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    return fail("internal_error", t("Não foi possível recomeçar o radar."), 500, { requestId });
  }

  if (resultado.data.mudou) {
    await audit({
      action: recomecar ? "radar.recomecado" : "radar.recomeco_desfeito",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "organization",
      resourceId: orgId,
      requestId,
      metadata: { desde: resultado.data.desde, antes: resultado.data.antes },
    });
  }

  return ok({ recomecado_em: resultado.data.desde }, { requestId });
}

export async function POST(_req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return definir(true);
}

export async function DELETE(_req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return definir(false);
}
