import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  janelasDosPaineis,
  origemDoContato,
  preencherDias,
  ROTULO_DA_ORIGEM,
  type Origem,
} from "@/lib/inicio/paineis";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/**
 * GET /api/v1/inicio/paineis — a "Visão da clínica" do Início, só para gestor
 * (spec docs/superpowers/specs/2026-10-07-inicio-paineis-design.md).
 *
 * Gestão decidida AQUI: esconder na tela não é permissão. Os números vêm das
 * funções SECURITY INVOKER da migration 0330 (agregam no banco; o PostgREST
 * cortaria a leitura em 1000 linhas). Cada painel roda isolado: um que falha vira
 * `{ ok:false }` e a tela avisa só nele, como os blocos de `/api/v1/inicio`.
 */
type Falha = { ok: false };
const FALHA: Falha = { ok: false };

async function isolado<T>(bloco: () => Promise<T>): Promise<T | Falha> {
  try {
    return await bloco();
  } catch {
    return FALHA;
  }
}

class ErroDoBanco extends Error {}
function exigir<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new ErroDoBanco(r.error.message);
  return r.data as T;
}

interface LinhaDeConversas {
  dia: string;
  ia_sozinha: number;
  com_equipe: number;
  sem_resposta: number;
  soma_primeira_resposta_s: number;
  respondidas: number;
}
interface LinhaDaAgenda {
  unit_id: string | null;
  unidade: string | null;
  marcadas: number;
  confirmadas: number;
  realizadas: number;
  faltas: number;
  canceladas: number;
}
interface BlocoDoFunil {
  ganhos: number;
  perdidos: number;
  valor: Record<string, string>;
}
interface Funil {
  etapas: Array<{ id: string; nome: string; abertos: number }>;
  mes: BlocoDoFunil;
  anterior: BlocoDoFunil;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "inicio" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const fuso = fusoUtilizavel(authz.org.timezone);
  const j = janelasDosPaineis(new Date(), fuso);
  const db = await createClient();

  const [conversas, agenda, funil, origem] = await Promise.all([
    isolado(async () => {
      const linhas = exigir<LinhaDeConversas[]>(
        await db.rpc("fn_inicio_conversas_por_dia", {
          p_org: orgId,
          p_inicio: j.conversas.inicio,
          p_fim: j.conversas.fim,
          p_fuso: fuso,
        }),
      ) ?? [];
      const soma = linhas.reduce((s, l) => s + Number(l.soma_primeira_resposta_s), 0);
      const respondidas = linhas.reduce((s, l) => s + l.respondidas, 0);
      return {
        ok: true as const,
        dias: preencherDias(j.conversas.dias, linhas),
        primeiraRespostaMediaS: respondidas ? Math.round(soma / respondidas) : null,
      };
    }),
    isolado(async () => {
      const linhas = exigir<LinhaDaAgenda[]>(
        await db.rpc("fn_inicio_agenda", { p_org: orgId, p_inicio: j.semana.inicio, p_fim: j.semana.fim }),
      ) ?? [];
      return {
        ok: true as const,
        de: j.semana.de,
        ate: j.semana.ate,
        unidades: linhas.map((l) => ({
          ...l,
          comparecimento: l.realizadas + l.faltas > 0 ? l.realizadas / (l.realizadas + l.faltas) : null,
        })),
      };
    }),
    isolado(async () => {
      const funis = exigir<Array<{ id: string; name: string; is_default: boolean }>>(
        await db
          .from("crm_pipelines")
          .select("id, name, is_default")
          .eq("organization_id", orgId)
          .eq("is_archived", false)
          .order("position"),
      ) ?? [];
      const lista = funis.map((f) => ({ id: f.id, nome: f.name }));
      const pedido = req.nextUrl.searchParams.get("funil");
      const escolhido = funis.find((f) => f.id === pedido) ?? funis.find((f) => f.is_default) ?? funis[0];
      if (!escolhido) return { ok: true as const, semFunil: true as const, funis: lista };
      const dados = exigir<Funil>(
        await db.rpc("fn_inicio_funil", {
          p_org: orgId,
          p_pipeline: escolhido.id,
          p_mes_inicio: j.mes.inicio,
          p_mes_fim: j.mes.fim,
          p_ant_inicio: j.mesAnterior.inicio,
        }),
      );
      return { ok: true as const, funilId: escolhido.id, funis: lista, ...dados };
    }),
    isolado(async () => {
      const linhas = exigir<Array<{ origem: string; utm_source: string | null; total: number }>>(
        await db.rpc("fn_inicio_origem", { p_org: orgId, p_inicio: j.mes.inicio, p_fim: j.mes.fim }),
      ) ?? [];
      const porOrigem = new Map<Origem, { total: number; detalhes: Array<{ utm: string; total: number }> }>();
      for (const l of linhas) {
        const o = origemDoContato(l.origem);
        const atual = porOrigem.get(o) ?? { total: 0, detalhes: [] };
        atual.total += l.total;
        if (l.utm_source) atual.detalhes.push({ utm: l.utm_source, total: l.total });
        porOrigem.set(o, atual);
      }
      return {
        ok: true as const,
        itens: [...porOrigem.entries()]
          .map(([o, v]) => ({ origem: o, rotulo: ROTULO_DA_ORIGEM[o], total: v.total, detalhes: v.detalhes }))
          .sort((a, b) => b.total - a.total),
      };
    }),
  ]);

  return ok({ conversas, agenda, funil, origem }, { requestId });
}
