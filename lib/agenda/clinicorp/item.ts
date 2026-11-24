/**
 * A resposta da Clinicorp, reduzida à OCUPAÇÃO — e só a ela.
 *
 * `GET /appointment/list` (Swagger oficial, https://sistema.clinicorp.com/api-docs/)
 * devolve a agenda inteira, e no item de paciente vêm nome, telefone, e-mail e
 * observação. Nada disso pode chegar ao banco, a log nem ao Sentry. A defesa é
 * de ENTRADA: o schema abaixo é `z.object` (não estrito), que DESCARTA toda chave
 * que não declara — e ele declara só id, datas, horários, profissional, clínica e
 * as marcas de desmarcado/excluído. O que sai daqui é intervalo, nunca pessoa.
 *
 * ─── As datas (o que o Swagger diz, e o que fica suposto) ────────────────────
 *
 * - Agendamento: `date` em UTC ("data e hora do agendamento") e `fromTime`/
 *   `toTime` em "HH:mm".
 * - Compromisso e evento: `AtomicDate` (YYYYMMDD) e `fromTime`/`toTime` no fuso
 *   da clínica; `AllDay = "X"` ocupa o dia inteiro.
 *
 * O dia vem de `AtomicDate` quando existe. Sem ele, de `date`: se a hora local
 * de `date` é o `fromTime`, `date` é o instante do começo e o dia é o local
 * dele. SUPOSIÇÃO (não medida sem credencial): se `date` vier à meia-noite UTC
 * sem casar com `fromTime`, ele é só a data, e o dia é o do próprio texto. O
 * começo e o fim saem sempre de `fromTime`/`toTime` no fuso da organização.
 *
 * Item sem profissional (`Dentist_PersonId` ausente) é "evento da unidade" pelo
 * Swagger: não é de ninguém, e fica de fora (a ocupação do motor é por pessoa).
 */
import { z } from "zod";

import { instanteDe, partesNoFuso } from "@/lib/agenda/fuso";

/** A ocupação como `fn_agenda_clinicorp_gravar` (migration 0433) a recebe. */
export interface OcupacaoDaClinicorp {
  external_id: string;
  professional_id: string;
  clinic_id: string | null;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "cancelled";
  external_updated_at: string | null;
}

/** Os ids da Clinicorp são inteiros grandes; chegam como número ou como texto (ver `jsonComIdsGrandes`). */
const idSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,30}$/)])
  .transform((v) => String(v));
const hhmmSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/);
/** "X" (maiúsculo ou não) liga; qualquer outra coisa não — a régua do próprio Swagger. */
// `.optional()` antes do transform: no Zod 4, `unknown().transform` torna a chave obrigatória.
const marcaSchema = z
  .unknown()
  .optional()
  .transform((v) => typeof v === "string" && v.trim().toUpperCase() === "X");

const itemSchema = z.object({
  id: idSchema,
  date: z.string().nullish(),
  AtomicDate: z.union([z.number().int(), z.string().regex(/^\d{8}$/)]).nullish(),
  fromTime: hhmmSchema.nullish(),
  toTime: hhmmSchema.nullish(),
  AllDay: marcaSchema,
  Dentist_PersonId: idSchema.nullish(),
  Clinic_BusinessId: idSchema.nullish(),
  Canceled: marcaSchema,
  Deleted: marcaSchema,
  z_LastChange_Date: z.string().nullish(),
});

const profissionalSchema = z.object({ id: idSchema, name: z.string().trim().max(200).nullish() });

type Dia = { ano: number; mes: number; dia: number };

const minutos = (hhmm: string): number => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

const doAtomico = (v: number | string): Dia | null => {
  const s = String(v);
  const dia = { ano: Number(s.slice(0, 4)), mes: Number(s.slice(4, 6)), dia: Number(s.slice(6, 8)) };
  const conferido = new Date(Date.UTC(dia.ano, dia.mes - 1, dia.dia));
  return conferido.getUTCMonth() === dia.mes - 1 && conferido.getUTCDate() === dia.dia ? dia : null;
};

function diaDoItem(item: z.infer<typeof itemSchema>, fuso: string): Dia | null {
  if (item.AtomicDate !== null && item.AtomicDate !== undefined) return doAtomico(item.AtomicDate);
  if (!item.date) return null;
  const instante = new Date(item.date);
  if (Number.isNaN(instante.getTime())) return null;
  const local = partesNoFuso(instante, fuso);
  if (item.fromTime && local.hora * 60 + local.minuto === minutos(item.fromTime)) {
    return { ano: local.ano, mes: local.mes, dia: local.dia };
  }
  // SUPOSIÇÃO (ver o cabeçalho): meia-noite UTC que não casa com `fromTime` é só a data.
  if (instante.getUTCHours() === 0 && instante.getUTCMinutes() === 0 && instante.getUTCSeconds() === 0) {
    return { ano: instante.getUTCFullYear(), mes: instante.getUTCMonth() + 1, dia: instante.getUTCDate() };
  }
  return { ano: local.ano, mes: local.mes, dia: local.dia };
}

const diaSeguinte = (d: Dia): Dia => {
  const x = new Date(Date.UTC(d.ano, d.mes - 1, d.dia + 1));
  return { ano: x.getUTCFullYear(), mes: x.getUTCMonth() + 1, dia: x.getUTCDate() };
};

/**
 * Um item da agenda da Clinicorp como OCUPAÇÃO, ou `null` quando ele não ocupa
 * ninguém do CRM (sem profissional) ou não dá para saber quando é.
 */
export function lerItemDaClinicorp(cru: unknown, fuso: string): OcupacaoDaClinicorp | null {
  const lido = itemSchema.safeParse(cru);
  if (!lido.success) return null;
  const item = lido.data;
  const profissional = item.Dentist_PersonId;
  if (!profissional) return null;

  const dia = diaDoItem(item, fuso);
  if (!dia) return null;

  let inicio: Date;
  let fim: Date;
  if (item.AllDay) {
    inicio = instanteDe(dia, fuso);
    fim = instanteDe(diaSeguinte(dia), fuso);
  } else {
    if (!item.fromTime || !item.toTime) return null;
    const de = minutos(item.fromTime);
    const ate = minutos(item.toTime);
    inicio = instanteDe({ ...dia, hora: Math.floor(de / 60), minuto: de % 60 }, fuso);
    fim = instanteDe({ ...dia, hora: Math.floor(ate / 60), minuto: ate % 60 }, fuso);
  }
  if (fim.getTime() <= inicio.getTime()) return null;

  const alterado = item.z_LastChange_Date ? new Date(item.z_LastChange_Date) : null;
  return {
    external_id: item.id,
    professional_id: profissional,
    clinic_id: item.Clinic_BusinessId ?? null,
    starts_at: inicio.toISOString(),
    ends_at: fim.toISOString(),
    status: item.Canceled || item.Deleted ? "cancelled" : "confirmed",
    external_updated_at: alterado && !Number.isNaN(alterado.getTime()) ? alterado.toISOString() : null,
  };
}

/** A lista inteira. Resposta que não é lista é erro de contrato, não agenda vazia. */
export function lerAgendaDaClinicorp(
  resposta: unknown,
  fuso: string,
): { ocupacoes: OcupacaoDaClinicorp[]; ignorados: number } {
  if (!Array.isArray(resposta)) throw new Error("resposta_fora_do_formato");
  const ocupacoes = resposta.flatMap((cru) => {
    const o = lerItemDaClinicorp(cru, fuso);
    return o ? [o] : [];
  });
  return { ocupacoes, ignorados: resposta.length - ocupacoes.length };
}

/** `GET /professional/list_all_professionals` → id e nome. CPF e e-mail ficam de fora. */
export function lerProfissionaisDaClinicorp(resposta: unknown): Array<{ professional_id: string; name: string | null }> {
  if (!Array.isArray(resposta)) throw new Error("resposta_fora_do_formato");
  return resposta.flatMap((cru) => {
    const p = profissionalSchema.safeParse(cru);
    return p.success ? [{ professional_id: p.data.id, name: p.data.name || null }] : [];
  });
}

/**
 * `JSON.parse` que não arredonda id. Inteiro acima de 2^53 perde dígitos no
 * `number` do JavaScript, e dois agendamentos diferentes virariam o mesmo id.
 * O reviver recebe o TEXTO original do número (Node 22) e o guarda como string.
 */
export function jsonComIdsGrandes(texto: string): unknown {
  const reviver = (_chave: string, valor: unknown, contexto?: { source?: string }) =>
    typeof valor === "number" && !Number.isSafeInteger(valor) && Number.isInteger(valor) && contexto?.source
      ? contexto.source
      : valor;
  return JSON.parse(texto, reviver as (this: unknown, key: string, value: unknown) => unknown);
}
