/**
 * PAINEL INÍCIO — o vocabulário comum dos blocos.
 *
 * Cada bloco é uma função pura (cliente de sessão + contexto → `Bloco`). A rota
 * roda todos isolados: um bloco que falha vira `{ ok:false }` e a tela mostra
 * "não consegui carregar" SÓ nele. Spec:
 * docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 */
export const FUSO_PADRAO = "America/Sao_Paulo";
export const LIMITE_DE_ITENS = 5;

export interface ItemDoBloco {
  id: string;
  titulo: string;
  detalhe?: string;
  href: string;
}

export type Bloco = { ok: true; total: number; itens: ItemDoBloco[] } | { ok: false };

export interface ContextoDoInicio {
  orgId: string;
  userId: string;
  agora: Date;
  fuso: string;
}

function fusoValido(fuso: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

/** Deslocamento (ms) do fuso em relação ao UTC num instante. */
function deslocamento(instante: Date, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instante);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/** [inicio, fim) do dia corrente no fuso, em ISO UTC, e o dia como `YYYY-MM-DD`. */
export function janelaDeHoje(agora: Date, fuso: string) {
  const tz = fusoValido(fuso);
  const local = new Date(agora.getTime() + deslocamento(agora, tz));
  const dia = local.toISOString().slice(0, 10);
  const meiaNoiteComoUtc = Date.parse(`${dia}T00:00:00.000Z`);
  const inicio = new Date(meiaNoiteComoUtc - deslocamento(new Date(meiaNoiteComoUtc), tz));
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio: inicio.toISOString(), fim: fim.toISOString(), dia };
}
