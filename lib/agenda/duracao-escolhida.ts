/**
 * A DURAÇÃO DO ATENDIMENTO ESCOLHIDA NA MARCAÇÃO — a faixa, num lugar só.
 *
 * Portado do projeto original (DeskcommCRM, PR #3714). A duração do tipo
 * (`calendar_event_types.duration_minutes` ou a do produto do catálogo)
 * continua sendo o PADRÃO; a recepção pode mudá-la para este atendimento.
 *
 * Sem coluna nova: a duração de um compromisso É `ends_at - starts_at` (e o
 * `duration_minutes_snapshot` guarda a mesma conta). A faixa 5…1440 é a do
 * `check` de `calendar_event_types`: a marcação não aceita o que o cadastro
 * recusaria.
 */

/** Piso da duração escolhida — o mesmo `check` de `calendar_event_types`. */
export const DURACAO_MINIMA_MIN = 5;

/** Teto da duração escolhida — idem. */
export const DURACAO_MAXIMA_MIN = 1440;

/** Inteiro de minutos dentro da faixa. `NaN`, `30.5` e string ficam de fora. */
export function duracaoEscolhidaValida(valor: unknown): valor is number {
  return (
    typeof valor === "number" &&
    Number.isInteger(valor) &&
    valor >= DURACAO_MINIMA_MIN &&
    valor <= DURACAO_MAXIMA_MIN
  );
}

/**
 * O que está no campo da tela, em minutos: `null` no texto = o padrão do
 * procedimento; texto inválido (vazio, "3", "abc") = `null`, e a tela trava o
 * Confirmar em vez de marcar outra coisa.
 */
export function duracaoDoCampo(texto: string | null, padraoMin: number): number | null {
  if (texto === null) return padraoMin;
  const t = texto.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return duracaoEscolhidaValida(n) ? n : null;
}

/**
 * Quanto dura o bloco que JÁ existe — o comprimento que a remarcação carrega.
 * Intervalo ilegível ou fora da faixa cai no padrão do tipo (o comportamento
 * anterior).
 */
export function duracaoDoBloco(inicioISO: string, fimISO: string | null | undefined, padraoMin: number): number {
  if (!fimISO) return padraoMin;
  const minutos = Math.round((new Date(fimISO).getTime() - new Date(inicioISO).getTime()) / 60_000);
  return duracaoEscolhidaValida(minutos) ? minutos : padraoMin;
}
