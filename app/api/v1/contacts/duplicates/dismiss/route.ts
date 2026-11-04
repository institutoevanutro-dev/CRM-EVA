/**
 * POST /api/v1/contacts/duplicates/dismiss — "Não são a mesma pessoa" (porte do #3640).
 *
 * Tira da seção "Parecidos — confira", para a organização toda, um par de
 * fichas que o NOME sugeriu. A dispensa é a linha de `merge_queue` gravada por
 * `dispensarParDeContatos`, sob trava: repetir, ou inverter o par, não grava
 * segunda linha.
 *
 * Só par de nome se dispensa. Mesmo telefone ou mesmo e-mail é `par_forte`
 * (422 `not_dismissable`): a sugestão forte não some por clique, junta-se.
 *
 * Esta rota é a porta: autoriza, valida, chama, audita. Mesmo papel da fusão
 * (`manager`, com a trava de MFA do `requireRole`), mesmo `requireSupportWrite`
 * antes do efeito. A organização é a da SESSÃO: o schema não tem campo para
 * `organization_id`, e um no corpo é descartado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { dispensarParDeContatos } from "@/lib/contacts/dispensar-par";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { contactsDismissDuplicateSchema, validateRequest } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "contact" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let input;
  try {
    input = await validateRequest(contactsDismissDuplicateSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Sem banco direto (`SUPABASE_DB_URL` ausente) ou com erro na transação, a
  // resposta segue o envelope `{error}` com `requestId` — nunca o 500 cru do Next.
  let resultado: Awaited<ReturnType<typeof dispensarParDeContatos>>;
  try {
    resultado = await dispensarParDeContatos(getRequestPool(), {
      organizationId: org.orgId,
      contactIds: input.contact_ids as [string, string],
      userId: user.id,
    });
  } catch {
    return fail("internal_error", "Não foi possível dispensar a sugestão agora.", 500, { requestId });
  }

  if (!resultado.ok) {
    if (resultado.motivo === "nao_encontrado") {
      return fail(
        "not_found",
        "Um dos contatos não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
        404,
        { requestId },
      );
    }
    return fail("not_dismissable", "Mesmo telefone ou mesmo e-mail não se dispensa: junte as fichas.", 422, {
      requestId,
    });
  }

  // Audit SÓ quando houve efeito: repetir a dispensa de um par já dispensado
  // não mudou nada. Metadata só com os ids — nunca nome nem telefone.
  if (resultado.criada) {
    const [primeiroId] = resultado.candidatos;
    await audit({
      action: "contact.duplicate_dismissed",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "contact",
      resourceId: primeiroId,
      requestId,
      metadata: { candidates: resultado.candidatos },
    });
  }

  return ok(
    { candidates: resultado.candidatos, criada: resultado.criada },
    { requestId, status: resultado.criada ? 201 : 200 },
  );
}
