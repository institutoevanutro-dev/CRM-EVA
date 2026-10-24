/**
 * STORIES DO DIA para o bônus da equipe. De hora em hora: o story some em 24h,
 * e uma leitura por dia perderia o da madrugada. Junta os ids no dia LOCAL de
 * cada story; quando a leitura é recusada, grava o motivo no dia de hoje para a
 * tela pedir o lançamento manual. Audita só quando entrou story novo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { programasAtivos } from "@/lib/bonus/fatos";
import { agruparStoriesPorDia, unirIds } from "@/lib/bonus/stories";
import { lerStoriesDaOrganizacao } from "@/lib/channels/instagram/stories";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();
  const lidos = await programasAtivos(admin);
  if (lidos.status === "erro") {
    logger.error("[bonus-stories] leitura dos programas falhou", { error: lidos.motivo, requestId });
    return fail("internal_error", "Falha ao ler os programas.", 500, { requestId });
  }

  const pulados: Record<string, number> = {};
  let novosNoTotal = 0;
  for (const programa of lidos.programas) {
    if (programa.regras.rotinas.stories_por_dia === 0) continue;
    const org = programa.organizationId;
    const hoje = diaLocalISO(agora, programa.fuso);
    const leitura = await lerStoriesDaOrganizacao(admin, org);
    if (!leitura.ok) {
      pulados[leitura.motivo] = (pulados[leitura.motivo] ?? 0) + 1;
      // Upsert só destas colunas: os ids já lidos e a contagem manual do dia ficam.
      const { error: erroMotivo } = await admin
        .from("bonus_stories_dia")
        .upsert({ organization_id: org, dia: hoje, leitura_erro: leitura.motivo, lido_em: agora.toISOString() }, { onConflict: "organization_id,dia" });
      if (erroMotivo) logger.error("[bonus-stories] gravação do motivo falhou", { organization_id: org, error: erroMotivo.message, requestId });
      continue;
    }

    const porDia = agruparStoriesPorDia(leitura.stories, programa.fuso);
    porDia.set(hoje, porDia.get(hoje) ?? []);
    const { data: atuais, error } = await admin
      .from("bonus_stories_dia")
      .select("dia, story_ids")
      .eq("organization_id", org)
      .in("dia", [...porDia.keys()]);
    if (error) {
      logger.error("[bonus-stories] leitura dos dias falhou", { organization_id: org, error: error.message, requestId });
      continue;
    }
    const idsAtuais = new Map((atuais ?? []).map((l) => [l.dia as string, (l.story_ids as string[]) ?? []]));

    let novos = 0;
    // ponytail: ler-unir-gravar sem trava; há um cron só por hora. Trocar por RPC com `array(select distinct …)` se surgir um segundo escritor.
    for (const [dia, ids] of porDia) {
      const { ids: unidos, acrescentados } = unirIds(idsAtuais.get(dia) ?? [], ids);
      const { error: erroGravar } = await admin
        .from("bonus_stories_dia")
        .upsert(
          { organization_id: org, dia, story_ids: unidos, leitura_erro: null, lido_em: agora.toISOString(), updated_at: agora.toISOString() },
          { onConflict: "organization_id,dia" },
        );
      if (erroGravar) {
        logger.error("[bonus-stories] gravação falhou", { organization_id: org, dia, error: erroGravar.message, requestId });
        continue;
      }
      novos += acrescentados;
    }
    if (novos > 0) {
      novosNoTotal += novos;
      await audit({ organizationId: org, action: "bonus.stories_lidos", resourceType: "bonus_stories_dia", metadata: { novos }, requestId });
    }
  }
  return ok({ programas: lidos.programas.length, novos: novosNoTotal, pulados }, { requestId });
}

export const GET = handle;
export const POST = handle;
