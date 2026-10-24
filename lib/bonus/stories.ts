/** Stories do dia, em funções puras. O story some em 24h; os ids se acumulam por dia local. */
import { diaLocalISO } from "@/lib/agenda/fuso";

export interface StoryLido {
  id: string;
  timestamp: string;
}

/** A plataforma devolve `+0000` sem dois-pontos; o `Date` só garante o formato ISO. */
export function normalizarTimestamp(ts: string): string {
  return ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

export function agruparStoriesPorDia(stories: readonly StoryLido[], fuso: string): Map<string, string[]> {
  const porDia = new Map<string, string[]>();
  for (const s of stories) {
    const instante = new Date(normalizarTimestamp(s.timestamp));
    if (Number.isNaN(instante.getTime())) continue;
    const dia = diaLocalISO(instante, fuso);
    porDia.set(dia, [...(porDia.get(dia) ?? []), s.id]);
  }
  return porDia;
}

export function unirIds(atuais: readonly string[], novos: readonly string[]): { ids: string[]; acrescentados: number } {
  const ids = [...new Set([...atuais, ...novos])];
  return { ids, acrescentados: ids.length - new Set(atuais).size };
}

export function contagemDoDia(linha: { story_ids: string[]; contagem_manual: number | null }): number {
  return linha.contagem_manual ?? linha.story_ids.length;
}
