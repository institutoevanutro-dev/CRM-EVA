/**
 * GET   /api/v1/ai/jev — o estado do Jev na organização e o que ele observou (manager+).
 * PATCH /api/v1/ai/jev — liga, desliga, aceita, muda tarefa (admin).
 *
 * Porte enxuto de melgarafael/DeskcommCRM #1575/#1696 (`app/api/v1/ai/jev`).
 * Fase 1: cada tarefa só pode estar `observando` ou `desligada`; nenhuma decide.
 *
 * A chave é da instalação (`JEV_API_KEY` no `.env`) e NUNCA sai daqui: a rota
 * só diz se ela existe. Sem chave, ligar é recusado (nada mudaria e a tela
 * mentiria). Ligar exige o aceite do administrador, no mesmo pedido ou antes:
 * a mensagem do cliente, limpa de CPF/telefone/e-mail, vai a um processador nos
 * EUA. Toda gravação é auditada (`ai.jev_settings_updated`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { MODELO_DO_JEV } from "@/lib/ai/decisao/cliente";
import {
  aplicarMudanca,
  ESTADOS_DA_TAREFA,
  estadoEfetivo,
  lerConfigDoJev,
  TAREFAS_DO_JEV,
  type IdDaTarefa,
} from "@/lib/ai/decisao/config";
import { jevTemChave } from "@/lib/ai/decisao/ponto";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const JANELA_DIAS = 30;

interface ResumoDaTarefa {
  observadas: number;
  comPar: number;
  concordou: number;
  /** Pedidos: o Jev disse "sim" onde a regra disse não. Clima: o Jev viu reclamação. */
  percebidas: number;
  latenciaMediaMs: number | null;
}

type Linha = { tarefa: string; rotulo_jev: string | null; concordou: boolean | null; latencia_ms: number | null };

export function resumir(linhas: readonly Linha[]): Record<IdDaTarefa, ResumoDaTarefa> {
  const resumo = Object.fromEntries(
    TAREFAS_DO_JEV.map((t) => [t, { observadas: 0, comPar: 0, concordou: 0, percebidas: 0, latenciaMediaMs: null }]),
  ) as Record<IdDaTarefa, ResumoDaTarefa>;
  const latencias = new Map<IdDaTarefa, number[]>();
  for (const l of linhas) {
    if (!(TAREFAS_DO_JEV as readonly string[]).includes(l.tarefa)) continue;
    const t = l.tarefa as IdDaTarefa;
    const r = resumo[t];
    r.observadas += 1;
    if (l.concordou !== null) r.comPar += 1;
    if (l.concordou === true) r.concordou += 1;
    if (l.rotulo_jev === "sim" || l.rotulo_jev === "reclamando") r.percebidas += 1;
    if (typeof l.latencia_ms === "number") latencias.set(t, [...(latencias.get(t) ?? []), l.latencia_ms]);
  }
  for (const [t, ms] of latencias) resumo[t].latenciaMediaMs = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  return resumo;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_jev" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const { data: org, error } = await admin.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const config = lerConfigDoJev((org as { settings?: unknown } | null)?.settings);

  const desde = new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString();
  const { data: linhas } = await admin
    .from("jev_observacoes")
    .select("tarefa, rotulo_jev, concordou, latencia_ms")
    .eq("organization_id", orgId)
    .gte("created_at", desde)
    .limit(10_000);

  return ok(
    {
      chaveConfigurada: jevTemChave(),
      modelo: MODELO_DO_JEV,
      ligado: config.ligado,
      aceite: config.aceite,
      tarefas: TAREFAS_DO_JEV.map((id) => ({ id, estado: estadoEfetivo(config, id) })),
      resumo: resumir((linhas ?? []) as Linha[]),
      janelaDias: JANELA_DIAS,
      podeEditar: roleAtLeast(authz.org.role, "admin"),
    },
    { requestId },
  );
}

const estado = z.enum(ESTADOS_DA_TAREFA);
const corpoDoPatch = z
  .object({
    ligado: z.boolean().optional(),
    aceitar: z.literal(true).optional(),
    tarefas: z.object({ clima: estado, humano: estado, opt_out: estado }).partial().strict().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_jev" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = corpoDoPatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const mudanca = parsed.data;
  if (mudanca.ligado === true && !jevTemChave()) {
    return fail("jev_sem_chave", t("O Jev precisa da chave JEV_API_KEY no servidor antes de ser ligado."), 409, {
      requestId,
    });
  }

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (erroLeitura) return fail("internal_error", erroLeitura.message, 500, { requestId });
  const settings = ((atual as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;

  const r = aplicarMudanca(lerConfigDoJev(settings), mudanca, authz.user.id, new Date());
  if (!r.ok) {
    return fail("jev_aceite_ausente", t("Ligar o Jev exige o aceite do administrador."), 422, { requestId });
  }

  const { error } = await admin
    .from("organizations")
    .update({ settings: { ...settings, jev: r.config } })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "ai.jev_settings_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { mudanca, ligado: r.config.ligado },
  });

  return ok(
    {
      ligado: r.config.ligado,
      aceite: r.config.aceite,
      tarefas: TAREFAS_DO_JEV.map((id) => ({ id, estado: estadoEfetivo(r.config, id) })),
    },
    { requestId },
  );
}
