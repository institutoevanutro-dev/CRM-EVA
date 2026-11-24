/**
 * Cron da cópia da Clinicorp (migration 0433) — a cada 10 minutos, pelo
 * `scheduler`. Copia a ocupação de toda organização com credencial
 * (`lib/agenda/clinicorp/copia.ts`).
 *
 * Audita só rodada com EFEITO (CLAUDE.md, "Audit log"): cópia que gravou alguma
 * mudança, ou falha NOVA (a mesma falha repetida a cada 10 minutos encheria a
 * trilha sem dizer nada que a primeira já não disse).
 */
import { NextResponse, type NextRequest } from "next/server";

import { copiarDaClinicorp } from "@/lib/agenda/clinicorp/copia";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Por rodada. Cada organização são ~4 pedidos à Clinicorp. */
const LIMITE = 20;

async function executar(req: NextRequest) {
  if (
    ![env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET]
      .filter(Boolean)
      .some((s) => req.headers.get("authorization") === `Bearer ${s}`)
  )
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  const db = createAdminClient();
  const { data, error } = await db
    .from("calendar_clinicorp_integrations")
    .select("organization_id")
    .order("last_sync_at", { nullsFirst: true })
    .limit(LIMITE);
  if (error)
    return NextResponse.json(
      { error: { code: "internal_error", message: "Não foi possível ler as integrações da Clinicorp." } },
      { status: 500 },
    );

  let copiadas = 0;
  let falhas = 0;
  for (const { organization_id: organizationId } of data ?? []) {
    const r = await copiarDaClinicorp(db, organizationId as string);
    if (r.ok) {
      copiadas += 1;
      if (r.gravados > 0)
        await audit({
          action: "agenda.clinicorp_copiada",
          organizationId: organizationId as string,
          resourceType: "calendar_clinicorp_integration",
          resourceId: organizationId as string,
          metadata: { origem: "cron", itens: r.itens, gravados: r.gravados },
        });
    } else if (r.motivo !== "nao_configurada") {
      falhas += 1;
      if (r.erroAnterior === null)
        await audit({
          action: "agenda.clinicorp_copiada",
          organizationId: organizationId as string,
          resourceType: "calendar_clinicorp_integration",
          resourceId: organizationId as string,
          metadata: { origem: "cron", falhou: r.motivo },
        });
    }
  }
  return NextResponse.json({ data: { integracoes: (data ?? []).length, copiadas, falhas } });
}

export const GET = executar;
export const POST = executar;
