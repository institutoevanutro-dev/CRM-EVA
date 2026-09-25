/**
 * PATCH  /api/v1/channels/instagram/:id: Origem padrão da conta (`null` limpa).
 * DELETE /api/v1/channels/instagram/:id: desconecta (arquiva a linha).
 *
 * manager+, org SEMPRE da sessão (o admin client ignora RLS). O corpo nunca
 * escolhe organização, e a resposta não carrega nome de provider.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { arquivarConexaoDoInstagram, definirOrigemPadrao } from "@/lib/channels/instagram/conexao";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  origem_padrao: z
    .object({
      campo: z.string().trim().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/i),
      valor: z.string().trim().min(1).max(200),
    })
    .nullable(),
});

async function autorizar(req: NextRequest, { params }: Context) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return { ok: false as const, response: authz.response };
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return { ok: false as const, response: fail("validation_failed", "Conta inválida.", 422, { requestId }) };
  }
  return { ok: true as const, authz, id, requestId };
}

export async function PATCH(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const a = await autorizar(req, ctx);
  if (!a.ok) return a.response;
  const { authz, id, requestId } = a;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Origem padrão inválida.", 422, { requestId });

  let achou: boolean;
  try {
    achou = await definirOrigemPadrao(createAdminClient(), authz.org.orgId, id, parsed.data.origem_padrao);
  } catch {
    return fail("internal_error", "Não foi possível salvar a origem padrão.", 500, { requestId });
  }
  if (!achou) return fail("not_found", "Conta não encontrada.", 404, { requestId });

  void audit({
    action: "channel.instagram_origem_changed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { origem_padrao: parsed.data.origem_padrao },
  });
  return ok({ id, origem_padrao: parsed.data.origem_padrao }, { requestId });
}

export async function DELETE(req: NextRequest, ctx: Context): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const a = await autorizar(req, ctx);
  if (!a.ok) return a.response;
  const { authz, id, requestId } = a;

  let arquivada: { username: string | null } | null;
  try {
    arquivada = await arquivarConexaoDoInstagram(createAdminClient(), authz.org.orgId, id);
  } catch {
    return fail("internal_error", "Não foi possível desconectar a conta.", 500, { requestId });
  }
  if (!arquivada) return fail("not_found", "Conta não encontrada.", 404, { requestId });

  void audit({
    action: "channel.instagram_disconnected",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { username: arquivada.username },
  });
  return ok({ id, desconectada: true }, { requestId });
}
