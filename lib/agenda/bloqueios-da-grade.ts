/**
 * OS BLOQUEIOS DE "DIAS FORA DA ROTINA", DESENHADOS NA GRADE.
 *
 * Um bloqueio (`calendar_availability_exceptions` com `is_unavailable`) já tirava
 * horários da consulta, mas não aparecia na Agenda: quem olhava a semana via o
 * horário vazio e não sabia por que ele não era oferecido. Aqui ele vira um bloco
 * inerte, no mesmo formato da ocupação do Google (`lerOcupacaoExterna`), para a
 * semente da página e a rota de listagem desenharem a MESMA coisa.
 *
 * ⚠️ Os minutos são do fuso da JORNADA de cada pessoa
 * (`attendant_availability.schedule.timezone`), que é a régua do motor
 * (`horariosLivres`). Sem jornada, cai no fuso da organização.
 *
 * Só bloqueio: a exceção que ABRE um dia é horário oferecido, não ocupado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO, instanteDe } from "./fuso";
import type { BlocoExternoDaTela, RecorteDaAgenda } from "./ocupacao-externa";

const DIA = 24 * 60 * 60_000;

interface LinhaDoBloqueio {
  id: string;
  user_id: string;
  exception_date: string;
  start_minute: number;
  end_minute: number;
}

/** "YYYY-MM-DD" + minutos no fuso → instante. 1440 vira 00:00 do dia seguinte. */
function instanteDoMinuto(dataISO: string, minuto: number, fuso: string): number {
  const [ano, mes, dia] = dataISO.split("-").map(Number) as [number, number, number];
  const base = new Date(Date.UTC(ano, mes - 1, dia, 0, minuto));
  return instanteDe(
    {
      ano: base.getUTCFullYear(),
      mes: base.getUTCMonth() + 1,
      dia: base.getUTCDate(),
      hora: base.getUTCHours(),
      minuto: base.getUTCMinutes(),
    },
    fuso,
  ).getTime();
}

export async function lerBloqueiosDaGrade(
  supabase: SupabaseClient,
  recorte: RecorteDaAgenda,
  donos: readonly string[],
  fusoPadrao: string,
): Promise<{ blocos: BlocoExternoDaTela[]; erro: string | null }> {
  if (donos.length === 0) return { blocos: [], erro: null };

  const de = new Date(recorte.de).getTime();
  const ate = new Date(recorte.ate).getTime();
  // Um dia de margem de cada lado: o fuso da jornada pode não ser o da tela.
  const [{ data: linhas, error }, { data: jornadas }] = await Promise.all([
    supabase
      .from("calendar_availability_exceptions")
      .select("id, user_id, exception_date, start_minute, end_minute")
      .eq("organization_id", recorte.organizationId)
      .eq("is_unavailable", true)
      .in("user_id", [...donos])
      .gte("exception_date", diaLocalISO(new Date(de - DIA), fusoPadrao))
      .lte("exception_date", diaLocalISO(new Date(ate + DIA), fusoPadrao)),
    supabase
      .from("attendant_availability")
      .select("user_id, schedule")
      .eq("organization_id", recorte.organizationId)
      .in("user_id", [...donos]),
  ]);
  if (error) return { blocos: [], erro: error.message };

  const fusoDe = new Map(
    (jornadas ?? []).map((j) => [
      String(j.user_id),
      (j.schedule as { timezone?: string } | null)?.timezone || fusoPadrao,
    ]),
  );

  const blocos: BlocoExternoDaTela[] = [];
  for (const b of (linhas ?? []) as LinhaDoBloqueio[]) {
    const fuso = fusoDe.get(b.user_id) ?? fusoPadrao;
    const data = String(b.exception_date).slice(0, 10);
    const inicio = Math.max(instanteDoMinuto(data, b.start_minute, fuso), de);
    const fim = Math.min(instanteDoMinuto(data, b.end_minute, fuso), ate);
    if (fim <= inicio) continue;
    blocos.push({
      id: `bloqueio:${b.id}`,
      donoId: b.user_id,
      iniciaEm: new Date(inicio).toISOString(),
      terminaEm: new Date(fim).toISOString(),
    });
  }
  return { blocos, erro: null };
}
