/**
 * DELETE /api/v1/contacts/[id]/prontuario-link — desfaz o vínculo entre este
 * contato e a ficha de paciente do Prontuário (`prontuario_contact_links`).
 *
 * Por que existe: o Prontuário pode ligar a ficha a um contato DUPLICADO
 * errado. Com o vínculo gravado, ligar a ficha ao contato certo falha com
 * `prontuario_link_conflict` em `fn_prontuario_link_existing`, e não havia
 * caminho de volta senão SQL manual em produção. Apagar a linha devolve as
 * duas pontas ao estado "sem vínculo"; nada é apagado no contato nem no
 * Prontuário.
 *
 * Auth dual (`lib/api/auth-dual.ts`):
 * - sessão: manager+, o mesmo piso de "Juntar com outra ficha";
 * - Bearer: escopo `prontuario:contacts:write`, o mesmo que CRIA o vínculo em
 *   `POST /api/v1/prontuario/contacts/link`. Quem pode ligar pode desligar —
 *   é isso que deixa o Prontuário corrigir a própria ligação errada. O rank
 *   exigido do token é o padrão de token (`agent`), como na rota que liga.
 *
 * A organização vem SEMPRE da sessão ou da linha do token, nunca do corpo (que
 * não existe). A escrita vai pela chave de serviço (a tabela não tem GRANT de
 * DELETE para `authenticated`), por isso o filtro explícito de organização.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { extractBearer } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Context): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const porToken = Boolean(extractBearer(req.headers.get("authorization")));
  if (!porToken) {
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "contacts",
    role: porToken ? "agent" : "manager",
    scope: "prontuario:contacts:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "prontuario_link", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("prontuario_contact_links")
    .delete()
    .eq("organization_id", authz.organizationId)
    .eq("contact_id", id)
    .select("*");
  if (error) {
    return fail("internal_error", t("Não foi possível desvincular do Prontuário."), 500, { requestId });
  }
  const apagado = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!apagado) {
    return fail("not_found", t("Este contato não está vinculado ao Prontuário."), 404, { requestId });
  }

  const { actor } = authz;
  await audit({
    action: "prontuario.contact_unlinked",
    actorUserId: actor.type === "user" ? actor.id : null,
    actorApiTokenId:
      actor.type === "api_token" ? actor.id : actor.type === "ai_agent" ? (actor.api_token_id ?? actor.id) : null,
    organizationId: authz.organizationId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { via: authz.via, vinculo_removido: apagado },
  });

  return ok(
    { contact_id: id, source_patient_id: apagado.source_patient_id, unlinked: true },
    { requestId },
  );
}
