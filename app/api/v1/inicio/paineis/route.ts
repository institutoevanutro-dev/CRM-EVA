import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  deCadaDez,
  janelasDosPaineis,
  origemDoContato,
  ROTULO_DA_ORIGEM,
  type Origem,
} from "@/lib/inicio/paineis";
import { corteDaEsperaRecente, janelaDeHoje } from "@/lib/inicio/tipos";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

/**
 * GET /api/v1/inicio/paineis — a "Visão da clínica" do Início, só para gestor
 * (specs docs/superpowers/specs/2026-10-07-inicio-paineis-design.md e
 * 2026-11-11-inicio-claro.md).
 *
 * Gestão decidida AQUI: esconder na tela não é permissão. Os números vêm das
 * funções SECURITY INVOKER das migrations 0330, 0376 e 0408 (agregam no banco; o
 * PostgREST cortaria a leitura em 1000 linhas). Cada painel roda isolado: um que
 * falha vira `{ ok:false }` e a tela avisa só nele, como os blocos de `/api/v1/inicio`.
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

interface Atendimento {
  ia_sozinha: number;
  com_equipe: number;
  sem_resposta: number;
  mediana_primeira_resposta_s: number | null;
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
interface Resumo {
  profissionais: Array<{
    user_id: string | null;
    hoje: number;
    semana: number;
    realizadas: number;
    faltas: number;
    canceladas: number;
    minutos: number;
  }>;
  vendas: { novos_mes: number; novos_anterior: number; ganhos_mes: number; perdidos_mes: number; valor: Record<string, string> };
}
interface Esperando {
  recentes: { total: number; sem_responsavel: number };
  antigas: { total: number };
}
interface Funil {
  etapas: Array<{ id: string; nome: string; abertos: number }>;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "inicio" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const fuso = fusoUtilizavel(authz.org.timezone);
  const agora = new Date();
  const j = janelasDosPaineis(agora, fuso);
  const hoje = janelaDeHoje(agora, fuso);
  const db = await createClient();

  const [resumo, atendimento, esperando, agenda, funil, origem] = await Promise.all([
    // Agenda por profissional e vendas do mês, de todos os funis (0376, corpo da 0408).
    isolado(async () => {
      const r = exigir<Resumo>(
        await db.rpc("fn_inicio_resumo_da_clinica", {
          p_org: orgId,
          p_hoje_inicio: hoje.inicio,
          p_hoje_fim: hoje.fim,
          p_semana_inicio: j.semana.inicio,
          p_semana_fim: j.semana.fim,
          p_mes_inicio: j.mes.inicio,
          p_mes_fim: j.mes.fim,
          p_ant_inicio: j.mesAnterior.inicio,
          // Os MESMOS DIAS do mês anterior, não o mês anterior inteiro.
          p_ant_fim: j.mesAnterior.fim,
        }),
      );
      // Uma chamada por profissional distinto (poucos numa clínica); sem service
      // role o mapa vem vazio e a tela diz "Profissional" — o número continua certo.
      const nomes = await nomesDosAtendentes(r.profissionais.map((p) => p.user_id));
      return {
        ok: true as const,
        profissionais: r.profissionais.map((p) => ({ ...p, nome: p.user_id ? (nomes.get(p.user_id) ?? null) : null })),
        vendas: r.vendas,
      };
    }),
    isolado(async () => {
      const a = exigir<Atendimento>(
        await db.rpc("fn_inicio_atendimento", { p_org: orgId, p_inicio: j.conversas.inicio, p_fim: j.conversas.fim }),
      );
      const faixas = { equipe: a.com_equipe, ia: a.ia_sozinha, semResposta: a.sem_resposta };
      return {
        ok: true as const,
        ...faixas,
        deCadaDez: deCadaDez(faixas),
        medianaPrimeiraRespostaS: a.mediana_primeira_resposta_s,
      };
    }),
    // A mesma função do "Meu dia", com o mesmo corte: gestor lê a clínica toda pela RLS.
    isolado(async () => {
      const e = exigir<Esperando>(
        await db.rpc("fn_inicio_esperando", { p_org: orgId, p_corte: corteDaEsperaRecente(agora) }),
      );
      return {
        ok: true as const,
        recentes: e.recentes.total,
        semResponsavel: e.recentes.sem_responsavel,
        antigas: e.antigas.total,
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
      // Só as etapas saem daqui: ganhos, perdidos e valor que a função também
      // devolve são DESTE funil, e o bloco de vendas soma todos (`resumo.vendas`).
      const { etapas } = exigir<Funil>(
        await db.rpc("fn_inicio_funil", {
          p_org: orgId,
          p_pipeline: escolhido.id,
          p_mes_inicio: j.mes.inicio,
          p_mes_fim: j.mes.fim,
          p_ant_inicio: j.mesAnterior.inicio,
        }),
      );
      return { ok: true as const, funilId: escolhido.id, funis: lista, etapas };
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

  return ok(
    { periodo: { mes: j.mes.de, mesAnterior: j.mesAnterior.de }, resumo, atendimento, esperando, agenda, funil, origem },
    { requestId },
  );
}
