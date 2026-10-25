/**
 * PUT /api/v1/bonus/stories — o aprovador lança a contagem do dia à mão
 * (quando a leitura automática não tem permissão, ou para corrigir). `null`
 * devolve o dia à leitura automática. A organização vem da sessão, nunca do corpo.
 * Só o período aberto: do dia 1 do mês de hoje até hoje, no fuso do programa
 * (a tela limita igual; a rota impõe). Dia impossível é 422, não 500.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerPrograma } from "@/lib/bonus/fatos";
import { diaNoPeriodo } from "@/lib/bonus/tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpo = z.object({
  dia: z.string().date(),
  contagem: z.number().int().min(0).max(50).nullable(),
});

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_stories_dia" });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);

  const parsed = corpo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  const admin = createAdminClient();
  const lido = await lerPrograma(admin, authz.org.orgId);
  if (lido.status !== "ok" || lido.programa.aprovadorUserId !== authz.user.id) {
    return fail("forbidden", t("Só quem aprova o bônus lança os stories."), 403, { requestId });
  }
  if (!diaNoPeriodo(parsed.data.dia, diaLocalISO(new Date(), lido.programa.fuso))) {
    return fail("validation_failed", t("Só dá para lançar os dias deste mês, até hoje."), 422, { requestId });
  }

  const { error } = await admin.from("bonus_stories_dia").upsert(
    {
      organization_id: authz.org.orgId,
      dia: parsed.data.dia,
      contagem_manual: parsed.data.contagem,
      lancado_por: authz.user.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,dia" },
  );
  if (error) return fail("internal_error", t("Erro ao salvar."), 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "bonus.stories_lancados",
    resourceType: "bonus_stories_dia",
    metadata: { dia: parsed.data.dia, manual: parsed.data.contagem !== null },
    requestId,
  });
  return ok({ dia: parsed.data.dia, contagem: parsed.data.contagem }, { requestId });
}
