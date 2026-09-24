/**
 * O período que a grade da Agenda DESENHA — e, portanto, o que ela tem de BUSCAR.
 *
 * Uma função só para as duas coisas. Enquanto a visão Mês desenhava 6 semanas a
 * partir do domingo da semana do dia 1 e a busca pedia só "de 1 a 30", os dias
 * vizinhos (1º de outubro na grade de setembro) apareciam na tela vazios, mesmo
 * com compromisso marcado.
 */
import { addDays, startOfDay, startOfMonth, startOfWeek } from "date-fns";

import type { VisaoDaAgenda } from "@/components/agenda/tipos";

// SEIS semanas sempre, mesmo quando o mês cabe em cinco: uma grade que ora tem
// 5 linhas, ora 6, muda a altura da célula ao virar o mês e quem olhava um dia
// perde a referência.
export const SEMANAS_DA_GRADE_DO_MES = 6;

/** Domingo da semana do dia 1 — a primeira célula da visão Mês. */
export function inicioDaGradeDoMes(ancora: Date): Date {
  return startOfWeek(startOfMonth(ancora), { weekStartsOn: 0 });
}

/** `[de, ate)` da grade, em instantes do fuso do browser. */
export function recorteDaVisao(visao: VisaoDaAgenda, ancora: Date): { de: Date; ate: Date } {
  if (visao === "mes") {
    const de = inicioDaGradeDoMes(ancora);
    return { de, ate: addDays(de, SEMANAS_DA_GRADE_DO_MES * 7) };
  }
  if (visao === "semana") {
    const de = startOfWeek(ancora, { weekStartsOn: 0 });
    return { de, ate: addDays(de, 7) };
  }
  const de = startOfDay(ancora);
  return { de, ate: addDays(de, 1) };
}
