/**
 * O calendário do bônus. Datas LOCAIS em `YYYY-MM-DD`: o cálculo compara dias,
 * nunca instantes, e o fuso entra só em `inicioDoDia`/`janelaDoMes`, que viram
 * filtro de banco. Dia útil = segunda a sexta, menos os feriados da regra.
 */
import { instanteDe } from "@/lib/agenda/fuso";

function partes(dia: string): [number, number, number] {
  const [a, m, d] = dia.split("-").map(Number);
  return [a!, m!, d!];
}

export function mesDe(dia: string): string {
  return dia.slice(0, 7);
}

export function somarDias(dia: string, n: number): string {
  const [a, m, d] = partes(dia);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

export function diasDoMes(mes: string): string[] {
  const [a, m] = mes.split("-").map(Number);
  const total = new Date(Date.UTC(a!, m!, 0)).getUTCDate();
  return Array.from({ length: total }, (_, i) => `${mes}-${String(i + 1).padStart(2, "0")}`);
}

export function ehDiaUtil(dia: string, feriados: readonly string[]): boolean {
  const [a, m, d] = partes(dia);
  const semana = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
  return semana >= 1 && semana <= 5 && !feriados.includes(dia);
}

export function diasUteisDoMes(mes: string, feriados: readonly string[]): string[] {
  return diasDoMes(mes).filter((dia) => ehDiaUtil(dia, feriados));
}

/** A meia-noite LOCAL daquele dia, como instante. */
export function inicioDoDia(dia: string, fuso: string): Date {
  const [ano, mes, d] = partes(dia);
  return instanteDe({ ano, mes, dia: d }, fuso);
}

export function janelaDoMes(mes: string, fuso: string): { inicio: Date; fim: Date } {
  const ultimo = diasDoMes(mes).at(-1)!;
  return { inicio: inicioDoDia(`${mes}-01`, fuso), fim: inicioDoDia(somarDias(ultimo, 1), fuso) };
}
