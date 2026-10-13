/**
 * A visão do funil que a pessoa escolheu (Quadro ou Calendário), guardada no
 * navegador dela.
 *
 * O upstream (#2790) deixou a escolha em estado local, perdida a cada recarga.
 * Aqui ela sobrevive: a visão e o período (mês/semana) valem para todos os
 * funis, e o campo de data é POR funil, porque cada funil tem os seus campos.
 *
 * `localStorage`, como a largura das faixas do Inbox: é preferência de quem
 * olha, não dado do negócio. Sem armazenamento (aba anônima, bloqueio do site)
 * a escolha vale só nesta visita, e nada lança.
 */
export type VisaoDoFunil = "quadro" | "calendario";
export type PeriodoDoCalendario = "mes" | "semana";

export interface PreferenciaDoFunil {
  visao: VisaoDoFunil;
  periodo: PeriodoDoCalendario;
  campo: string | null;
  campoFim: string | null;
}

const CHAVE = "funil.visao.v1";

export const PREFERENCIA_PADRAO: PreferenciaDoFunil = {
  visao: "quadro",
  periodo: "mes",
  campo: null,
  campoFim: null,
};

interface Guardado {
  visao?: unknown;
  periodo?: unknown;
  campos?: Record<string, { campo?: unknown; campoFim?: unknown } | undefined>;
}

function ler(): Guardado {
  try {
    const dado: unknown = JSON.parse(window.localStorage.getItem(CHAVE) ?? "{}");
    return dado && typeof dado === "object" ? (dado as Guardado) : {};
  } catch {
    return {};
  }
}

const texto = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function lerPreferencia(pipelineId: string): PreferenciaDoFunil {
  const g = ler();
  const doFunil = g.campos?.[pipelineId];
  return {
    // Valor que não é um dos dois vira o padrão: a chave pode ter sido gravada
    // por outra versão, ou editada à mão.
    visao: g.visao === "calendario" ? "calendario" : "quadro",
    periodo: g.periodo === "semana" ? "semana" : "mes",
    campo: texto(doFunil?.campo),
    campoFim: texto(doFunil?.campoFim),
  };
}

export function gravarPreferencia(pipelineId: string, p: PreferenciaDoFunil): void {
  try {
    const g = ler();
    window.localStorage.setItem(
      CHAVE,
      JSON.stringify({
        visao: p.visao,
        periodo: p.periodo,
        campos: { ...g.campos, [pipelineId]: { campo: p.campo, campoFim: p.campoFim } },
      }),
    );
  } catch {
    // Sem persistência a escolha vale nesta visita.
  }
}
