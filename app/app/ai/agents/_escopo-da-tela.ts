import type { FunilDaResposta } from "@/hooks/pipelines/usePipelines";
import { coberturaDoFunil, type EtapaDoMapa } from "@/lib/leads/agent-mapping";
import type { createClient } from "@/lib/supabase/server";

import type { MaterialDoAcervo } from "./[id]/_components/BasesDoAgente";
import type { CoberturaPorFunil } from "./[id]/_components/FunisDoAgente";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Os funis e o acervo da organização — o que "Em que negócios ele pode mexer" e
 * "O que ele consulta antes de responder" mostram —, para as DUAS telas que
 * montam o formulário do agente.
 *
 * Vêm com a página, não por fetch no cliente: as duas seções usam a lista vazia
 * para dizer algo importante ("você ainda não cadastrou nenhum"), e uma lista
 * que chega vazia no primeiro render diria isso por engano. A tela de criar
 * agente não buscava nenhuma das duas e dizia isso sempre, para todo mundo.
 */
export async function lerFunisEMateriais(
  supabase: Supabase,
  orgId: string,
): Promise<{ funis: FunilDaResposta[]; cobertura: CoberturaPorFunil; materiais: MaterialDoAcervo[] }> {
  const [funisRes, acervoRes, etapasRes] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, name, slug, description, position, is_default")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("ai_knowledge_sources")
      .select("id, name, source_type, chunks_count, last_index_status, is_active")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("created_at", { ascending: true }),
    // Quanto de cada funil o assistente sabe percorrer (spec 17 passo 4). A
    // lacuna precisa aparecer no MESMO lugar em que o dono marca o funil —
    // descobrir isso entrando funil por funil na tela de tradução é o que fez 3
    // dos 4 funis da produção ficarem mudos sem ninguém ver.
    supabase
      .from("crm_stages")
      .select("id, name, is_won, is_lost, agent_stage_hint, pipeline_id")
      .eq("organization_id", orgId)
      .eq("is_archived", false),
  ]);

  const funis = (funisRes.data ?? []) as unknown as FunilDaResposta[];
  const etapasPorFunil = new Map<string, EtapaDoMapa[]>();
  for (const e of (etapasRes.data ?? []) as Array<EtapaDoMapa & { pipeline_id: string }>) {
    etapasPorFunil.set(e.pipeline_id, [...(etapasPorFunil.get(e.pipeline_id) ?? []), e]);
  }
  const cobertura: CoberturaPorFunil = {};
  for (const f of funis) {
    const c = coberturaDoFunil(etapasPorFunil.get(f.id) ?? []);
    cobertura[f.id] = { traduzidos: c.traduzidos, total: c.total, mudo: c.mudo };
  }
  return {
    funis,
    cobertura,
    materiais: (acervoRes.data ?? []) as unknown as MaterialDoAcervo[],
  };
}
