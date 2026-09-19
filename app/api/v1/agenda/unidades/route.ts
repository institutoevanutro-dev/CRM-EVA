import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const criar = z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().trim().min(1).max(64).default("America/Sao_Paulo") });
const alterar = criar.partial().extend({ id: z.string().uuid(), active: z.boolean().optional() });

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("viewer", { requestId, resource: "calendar_units" });
  if (!auth.ok) return auth.response;
  const { data, error } = await createAdminClient().from("calendar_units").select("id,name,timezone,active").eq("organization_id", auth.org.orgId).order("name");
  return error ? fail("internal_error", error.message, 500, { requestId }) : ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest) {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "calendar_units" }); if (!auth.ok) return auth.response;
  const body = criar.safeParse(await req.json().catch(() => ({}))); if (!body.success) return fail("validation_failed", body.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  const { data, error } = await createAdminClient().from("calendar_units").insert({ ...body.data, organization_id: auth.org.orgId }).select("id,name,timezone,active").single();
  if (error) return fail(error.code === "23505" ? "conflict" : "internal_error", error.message, error.code === "23505" ? 409 : 500, { requestId });
  await audit({ actorUserId: auth.user.id, action: "agenda.unidade_criada", organizationId: auth.org.orgId, resourceType: "calendar_unit", resourceId: data.id, metadata: { name: data.name } });
  return ok(data, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const auth = await requireRole("manager", { requestId, resource: "calendar_units" }); if (!auth.ok) return auth.response;
  const body = alterar.safeParse(await req.json().catch(() => ({}))); if (!body.success) return fail("validation_failed", body.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  const { id, ...changes } = body.data; if (!Object.keys(changes).length) return fail("validation_failed", "Nenhum campo para alterar.", 422, { requestId });
  const { data, error } = await createAdminClient().from("calendar_units").update(changes).eq("organization_id", auth.org.orgId).eq("id", id).select("id,name,timezone,active").maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId }); if (!data) return fail("not_found", "Unidade não encontrada.", 404, { requestId });
  await audit({ actorUserId: auth.user.id, action: "agenda.unidade_alterada", organizationId: auth.org.orgId, resourceType: "calendar_unit", resourceId: id, metadata: { fields: Object.keys(changes) } });
  return ok(data, { requestId });
}
