/** GET /api/v1/bonus/equipe?mes=YYYY-MM: os placares lado a lado. Só o aprovador. */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { calcularMes } from "@/lib/bonus/calculo";
import { mesDe } from "@/lib/bonus/calendario";
import { fatosDoMes, historicoDeEnvioRecente, lerPrograma } from "@/lib/bonus/fatos";
import { tamanhoDaFilaDeLeads } from "@/lib/bonus/fila";
import { contagemDoDia } from "@/lib/bonus/stories";
import type { RespostaDaEquipe } from "@/lib/bonus/tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

const MES_RX = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_programas" });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);
  const admin = createAdminClient();
  const lido = await lerPrograma(admin, authz.org.orgId);
  if (lido.status !== "ok" || lido.programa.aprovadorUserId !== authz.user.id) {
    return fail("forbidden", t("Só quem aprova o bônus vê os placares da equipe."), 403, { requestId });
  }
  const programa = lido.programa;
  const hoje = diaLocalISO(new Date(), programa.fuso);
  const pedido = new URL(req.url).searchParams.get("mes");
  const mes = pedido && MES_RX.test(pedido) ? pedido : mesDe(hoje);

  try {
    const [entrada, historico, nomes, storiesHoje] = await Promise.all([
      fatosDoMes(admin, programa, mes, hoje),
      historicoDeEnvioRecente(admin, programa, hoje),
      nomesDosAtendentes(programa.regras.participantes),
      admin
        .from("bonus_stories_dia")
        .select("story_ids, contagem_manual, leitura_erro")
        .eq("organization_id", programa.organizationId)
        .eq("dia", hoje)
        .maybeSingle(),
    ]);
    if (storiesHoje.error) throw new Error(storiesHoje.error.message);
    const linha = storiesHoje.data as { story_ids: string[]; contagem_manual: number | null; leitura_erro: string | null } | null;
    const corpo: RespostaDaEquipe = {
      mes,
      hoje,
      placar: calcularMes(entrada),
      nomes: Object.fromEntries(programa.regras.participantes.map((id) => [id, nomes.get(id) ?? null])),
      stories_hoje: { contagem: linha ? contagemDoDia(linha) : 0, leitura_erro: linha?.leitura_erro ?? null },
      fila_reduzida_hoje: tamanhoDaFilaDeLeads(programa.regras, historico).reduzida,
    };
    return ok(corpo, { requestId });
  } catch (e) {
    logger.error("[bonus.equipe] leitura falhou", { organization_id: programa.organizationId, error: e instanceof Error ? e.message : String(e), requestId });
    return fail("internal_error", t("Erro ao montar os placares."), 500, { requestId });
  }
}
