/**
 * POST /api/v1/agenda/clinicorp/importar — a foto do que já está marcado na
 * Clinicorp, vinda do relatório exportado (migration 0435). Gate = manager+,
 * organização da sessão.
 *
 * O arquivo NÃO chega aqui: a tela o lê no navegador
 * (`lib/agenda/clinicorp/exportacao.ts`) e manda só dia, início, fim e a pessoa
 * da Agenda escolhida pelo gestor para cada nome de profissional. O schema é
 * estrito: um campo a mais (um nome de paciente, por exemplo) recusa o pedido
 * inteiro. A auditoria registra só contagens.
 *
 * O dia e a hora são do relógio da clínica; o instante sai do fuso da
 * organização. O que já passou não entra. Cada importação substitui a anterior.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { instanteDe } from "@/lib/agenda/fuso";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const corpoSchema = z.strictObject({
  horarios: z
    .array(
      z.strictObject({
        dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        de: hora,
        ate: hora,
        user_id: z.string().uuid(),
      }),
    )
    .min(1)
    .max(5000),
});

const parede = (dia: string, hhmm: string) => {
  const [ano, mes, d] = dia.split("-").map(Number) as [number, number, number];
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return { ano, mes, dia: d, hora: h, minuto: m };
};

const diaExiste = (dia: string) => {
  const [a, m, d] = dia.split("-").map(Number) as [number, number, number];
  const x = new Date(Date.UTC(a, m - 1, d));
  return x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
};

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "calendar_event_types" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("Importação inválida."), 422, { requestId });
  const horarios = lido.data.horarios.filter((h) => diaExiste(h.dia) && h.ate > h.de);
  if (horarios.length !== lido.data.horarios.length) {
    return fail("validation_failed", t("Importação inválida."), 422, { requestId });
  }
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const [{ data: integracao, error: erroIntegracao }, { data: organizacao }] = await Promise.all([
    admin.from("calendar_clinicorp_integrations").select("organization_id").eq("organization_id", org).maybeSingle(),
    admin.from("organizations").select("timezone").eq("id", org).maybeSingle(),
  ]);
  if (erroIntegracao) return fail("internal_error", erroIntegracao.message, 500, { requestId });
  if (!integracao) {
    return fail("not_found", t("Gere o endereço do webhook ou salve a credencial da Clinicorp primeiro."), 404, { requestId });
  }

  // A pessoa tem de ser desta equipe, e ativa: `user_id` referencia só `auth.users`.
  const pessoas = [...new Set(horarios.map((h) => h.user_id))];
  const { data: membros, error: erroMembros } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", org)
    .is("revoked_at", null)
    .in("user_id", pessoas);
  if (erroMembros) return fail("internal_error", erroMembros.message, 500, { requestId });
  if ((membros ?? []).length !== pessoas.length) {
    return fail("validation_failed", t("Essa pessoa não faz parte desta equipe."), 422, { requestId });
  }

  const fuso = fusoUtilizavel((organizacao as { timezone?: string | null } | null)?.timezone);
  const agora = Date.now();
  const itens = horarios
    .map((h) => ({
      user_id: h.user_id,
      starts_at: instanteDe(parede(h.dia, h.de), fuso).toISOString(),
      ends_at: instanteDe(parede(h.dia, h.ate), fuso).toISOString(),
    }))
    .filter((i) => new Date(i.ends_at).getTime() > agora);

  const { data: gravados, error } = await admin.rpc("fn_agenda_clinicorp_importar", { p_org: org, p_itens: itens });
  if (error) return fail("internal_error", t("Não consegui gravar a importação."), 500, { requestId });

  const resultado = { recebidos: horarios.length, gravados: Number(gravados ?? 0), passados: horarios.length - itens.length };
  void audit({
    action: "agenda.clinicorp_importada",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "calendar_clinicorp_integration",
    resourceId: authz.org.orgId,
    requestId,
    // Só contagens: nem horário, nem pessoa, nem nada do arquivo.
    metadata: resultado,
  });
  return ok(resultado, { requestId });
}
