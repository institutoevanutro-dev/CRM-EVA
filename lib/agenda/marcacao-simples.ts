/**
 * As regras puras do "Novo agendamento" simples (modal de duas abas).
 *
 * A ordem da tela é PROFISSIONAL → PROCEDIMENTO, e a ligação entre os dois é a
 * única que o banco tem: `calendar_event_types.default_owner_user_id`. Um
 * procedimento com dono aparece só para o dono; um procedimento SEM dono é de
 * qualquer profissional e aparece para todos. Não existe tabela de "quem atende
 * o quê" com mais de uma pessoa por tipo; se um dia existir, a troca é aqui.
 */

/** O mínimo que a regra precisa saber de um tipo de agendamento. */
export type ProcedimentoComDono = { id: string; donoId: string | null };

/**
 * Os procedimentos que o profissional escolhido atende. Sem profissional, nada:
 * a tela deixa o campo de procedimento desligado até ele ser escolhido.
 *
 * ⚠️ `default_owner_user_id` é o dono PADRÃO, não exclusivo: a rota sempre
 * aceitou marcar o tipo de uma pessoa na agenda de outra (é o que o filtro de
 * uma pessoa na grade faz). Por isso o resto não some da tela: vai para
 * `outrosProcedimentos`, num grupo separado no fim da lista.
 */
export function procedimentosDoProfissional<T extends ProcedimentoComDono>(
  tipos: readonly T[],
  profissionalId: string | null | undefined,
): T[] {
  if (!profissionalId) return [];
  return tipos.filter((t) => t.donoId === null || t.donoId === profissionalId);
}

/** Os procedimentos de OUTROS profissionais: ainda marcáveis, mas no fim da lista. */
export function outrosProcedimentos<T extends ProcedimentoComDono>(
  tipos: readonly T[],
  profissionalId: string | null | undefined,
): T[] {
  if (!profissionalId) return [];
  return tipos.filter((t) => t.donoId !== null && t.donoId !== profissionalId);
}

/** O instante em que o atendimento termina: começo + duração do procedimento. */
export function fimDoHorario(instante: string, duracaoMin: number): string {
  return new Date(new Date(instante).getTime() + duracaoMin * 60_000).toISOString();
}

/**
 * Todos os dias de `inicio` a `fim`, inclusive (`yyyy-MM-dd`). Sem `fim`, ou com
 * `fim` antes do início, é o próprio dia. O teto segura um ano digitado errado,
 * que viraria centenas de linhas para apagar uma a uma.
 *
 * Meio-dia UTC pela mesma razão de `DiasBloqueados`: a aritmética é de DIAS, e
 * meia-noite somada a fuso a oeste volta um dia ao formatar.
 */
export function datasDoPeriodo(inicio: string, fim: string | null | undefined, teto: number): string[] {
  const ultimo = new Date(`${fim && fim > inicio ? fim : inicio}T12:00:00Z`).getTime();
  const datas: string[] = [];
  for (let d = new Date(`${inicio}T12:00:00Z`); d.getTime() <= ultimo; d.setUTCDate(d.getUTCDate() + 1)) {
    if (datas.length >= teto) break;
    datas.push(d.toISOString().slice(0, 10));
  }
  return datas;
}
