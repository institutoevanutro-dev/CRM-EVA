/**
 * A FILA DO DIA do bônus da equipe.
 *
 * De hora em hora (o agendador roda em UTC); só age na organização cujo
 * relógio local está entre a hora da regra (7h) e o meio-dia, em dia útil, e
 * só uma vez por dia: `fn_bonus_montar_fila` devolve `ja_montada` nas rodadas
 * seguintes. Antes de montar, a proteção do número decide o tamanho da fila de
 * leads antigos (`lib/bonus/fila.ts`) e, se reduziu, avisa na Central.
 *
 * Auditoria e aviso só quando houve efeito (CLAUDE.md §Audit log): a função
 * devolve o `row_count` real do `on conflict do nothing`, então de duas rodadas
 * simultâneas só a que inseriu audita e avisa.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { avisarFilaReduzida } from "@/lib/bonus/aviso";
import { ehDiaUtil } from "@/lib/bonus/calendario";
import { historicoDeEnvioRecente, programasAtivos } from "@/lib/bonus/fatos";
import { deveMontarAgora, participantesValidos, relogioDoPrograma, tamanhoDaFilaDeLeads } from "@/lib/bonus/fila";
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
    logger.error("[bonus-fila] leitura dos programas falhou", { error: lidos.motivo, requestId });
    return fail("internal_error", "Falha ao ler os programas.", 500, { requestId });
  }

  let montadas = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + 1;
  };

  for (const programa of lidos.programas) {
    const { hora, dia } = relogioDoPrograma(agora, programa.fuso);
    if (!ehDiaUtil(dia, programa.regras.feriados)) continue;
    if (!deveMontarAgora(hora, programa.regras.fila.hora_local)) continue;

    // A regra guarda ids; quem saiu da organização não recebe fila.
    const { data: membros, error: erroMembros } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", programa.organizationId)
      .is("revoked_at", null)
      .in("user_id", programa.regras.participantes.filter(Boolean));
    if (erroMembros) {
      logger.error("[bonus-fila] leitura dos membros falhou", {
        organization_id: programa.organizationId,
        error: erroMembros.message,
        requestId,
      });
      pular("membros_falhou");
      continue;
    }
    const participantes = participantesValidos(
      programa.regras.participantes,
      ((membros ?? []) as { user_id: string }[]).map((m) => m.user_id),
    );
    if (participantes.length === 0) {
      pular("sem_participantes");
      continue;
    }

    let tamanho = programa.regras.rotinas.leads_por_dia;
    let reduzida = false;
    try {
      ({ tamanho, reduzida } = tamanhoDaFilaDeLeads(programa.regras, await historicoDeEnvioRecente(admin, programa, dia)));
    } catch (e) {
      // Sem histórico não se sabe se o número está em risco: monta com o tamanho
      // reduzido, que é o lado seguro, e registra.
      logger.error("[bonus-fila] histórico de envio falhou", {
        organization_id: programa.organizationId,
        error: e instanceof Error ? e.message : String(e),
        requestId,
      });
      tamanho = Math.floor((tamanho * programa.regras.protecao.fracao_reduzida_bps) / 10_000);
      pular("historico_falhou");
    }

    const { data, error } = await admin.rpc("fn_bonus_montar_fila", {
      p_org: programa.organizationId,
      p_dia: dia,
      p_agora: agora.toISOString(),
      p_participantes: participantes,
      p_leads_por_pessoa: tamanho,
      p_ligacoes_por_pessoa: programa.regras.rotinas.ligacoes_por_dia,
      p_fila: programa.regras.fila,
    });
    if (error) {
      logger.error("[bonus-fila] montagem falhou", { organization_id: programa.organizationId, error: error.message, requestId });
      pular("montagem_falhou");
      continue;
    }
    const r = data as { leads: number; ligacoes: number; ja_montada: boolean };
    if (r.ja_montada) continue;
    if (r.leads + r.ligacoes > 0) {
      montadas += 1;
      if (reduzida) await avisarFilaReduzida(admin, programa, tamanho);
      await audit({
        organizationId: programa.organizationId,
        action: "bonus.fila_montada",
        resourceType: "bonus_fila_itens",
        metadata: { dia, leads: r.leads, ligacoes: r.ligacoes, reduzida },
        requestId,
      });
    }
  }

  return ok({ programas: lidos.programas.length, montadas, pulados }, { requestId });
}

export const GET = handle;
export const POST = handle;
