/**
 * Funil de Desempenho separado por funil (auditoria 17/11, item 159).
 *
 * `fn_attendant_metrics` devolve as etapas de TODOS os funis numa lista só,
 * sem dizer de qual funil cada uma é, e inclui as etapas de ganho e perda —
 * que mostram sempre 0, porque a contagem é só de leads `open`. Aqui a lista
 * é repartida por funil e as etapas de ganho/perda saem. Sem migration: as
 * pistas que faltam (funil da etapa, `is_won`/`is_lost`) vêm de `crm_stages`.
 */

export interface EtapaDoFunil {
  stage_id: string;
  stage_name: string;
  position: number;
  count: number;
}

export interface EtapaInfo {
  id: string;
  pipeline_id: string;
  is_won: boolean;
  is_lost: boolean;
}

export interface FunilInfo {
  id: string;
  name: string;
  is_default: boolean;
  position: number;
}

export interface FunilAgrupado {
  pipeline_id: string;
  pipeline_name: string;
  is_default: boolean;
  etapas: EtapaDoFunil[];
}

/** Padrão primeiro, depois a ordem do Kanban. Funil sem etapa aberta some. */
export function agruparFunilPorPipeline(
  etapas: EtapaDoFunil[],
  infoEtapas: EtapaInfo[],
  funis: FunilInfo[],
): FunilAgrupado[] {
  const porEtapa = new Map(infoEtapas.map((e) => [e.id, e]));
  const porFunil = new Map<string, EtapaDoFunil[]>();
  for (const etapa of etapas) {
    const info = porEtapa.get(etapa.stage_id);
    if (!info || info.is_won || info.is_lost) continue;
    const lista = porFunil.get(info.pipeline_id) ?? [];
    lista.push(etapa);
    porFunil.set(info.pipeline_id, lista);
  }
  return [...funis]
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.position - b.position)
    .filter((f) => porFunil.has(f.id))
    .map((f) => ({
      pipeline_id: f.id,
      pipeline_name: f.name,
      is_default: f.is_default,
      etapas: porFunil.get(f.id)!,
    }));
}
