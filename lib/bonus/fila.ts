/**
 * A fila do dia, em funções puras: qual item recebeu mensagem, quanto de cada
 * rotina a pessoa fez, e se a fila de amanhã diminui para proteger o número.
 *
 * "Mensagem da fila" = mensagem ENVIADA PELO CRM, pela MESMA pessoa, ao MESMO
 * contato, no MESMO dia local do item. Mensagem do celular chega ao banco como
 * `sent_via = 'external_device'` e o coletor já não a traz.
 */
import { diaLocalISO, partesNoFuso } from "@/lib/agenda/fuso";
import { FUSO_PADRAO } from "@/lib/tempo/fusos";

import type { RotinaDoDia } from "./calculo";
import { inicioDoDia, somarDias } from "./calendario";
import type { RegrasDoBonus } from "./regras";
import type { TipoDeItemDaFila } from "./tipos";

export interface ItemDaFila {
  id: string;
  dia: string;
  tipo: TipoDeItemDaFila;
  userId: string;
  contactId: string;
  ligacaoRegistradaEm: string | null;
}

export interface MensagemDaEquipe {
  contactId: string;
  userId: string;
  sentAt: string;
}

export interface DiaDeEnvio {
  dia: string;
  enviados: number;
  pedidosParaParar: number;
}

/** A montagem roda entre a hora da regra e o meio-dia: depois disso, só amanhã. */
const HORA_LIMITE_DA_MONTAGEM = 12;

export function deveMontarAgora(horaLocal: number, horaDaFila: number): boolean {
  return horaLocal >= horaDaFila && horaLocal < HORA_LIMITE_DA_MONTAGEM;
}

/**
 * Hora e dia locais do programa. O fuso já chega saneado de `fatos.ts`; isto é
 * defesa: um fuso que o `Intl` recusa cai em `FUSO_PADRAO`, em vez de pular o dia.
 */
export function relogioDoPrograma(agora: Date, fuso: string): { hora: number; dia: string } {
  try {
    return { hora: partesNoFuso(agora, fuso).hora, dia: diaLocalISO(agora, fuso) };
  } catch {
    return { hora: partesNoFuso(agora, FUSO_PADRAO).hora, dia: diaLocalISO(agora, FUSO_PADRAO) };
  }
}

/** Os participantes da regra que são membros ATIVOS da organização, sem nulos nem repetidos. */
export function participantesValidos(lista: readonly (string | null | undefined)[], membros: readonly string[]): string[] {
  const ativos = new Set(membros);
  return [...new Set(lista)].filter((id): id is string => typeof id === "string" && id !== "" && ativos.has(id));
}

export function itensEnviados(
  itens: readonly ItemDaFila[],
  mensagens: readonly MensagemDaEquipe[],
  fuso: string,
): Set<string> {
  const chaves = new Set(mensagens.map((m) => `${m.userId}|${m.contactId}|${diaLocalISO(new Date(m.sentAt), fuso)}`));
  return new Set(
    itens.filter((i) => i.tipo === "lead_antigo" && chaves.has(`${i.userId}|${i.contactId}|${i.dia}`)).map((i) => i.id),
  );
}

export function rotinasDaPessoa(
  itens: readonly ItemDaFila[],
  enviados: ReadonlySet<string>,
  userId: string,
): { leads: RotinaDoDia[]; ligacoes: RotinaDoDia[] } {
  const leads = new Map<string, RotinaDoDia>();
  const ligacoes = new Map<string, RotinaDoDia>();
  for (const i of itens) {
    if (i.userId !== userId) continue;
    const mapa = i.tipo === "lead_antigo" ? leads : ligacoes;
    const r = mapa.get(i.dia) ?? { dia: i.dia, meta: 0, feitos: 0 };
    r.meta += 1;
    const feito = i.tipo === "lead_antigo" ? enviados.has(i.id) : i.ligacaoRegistradaEm !== null;
    if (feito) r.feitos += 1;
    mapa.set(i.dia, r);
  }
  const emOrdem = (m: Map<string, RotinaDoDia>) => [...m.values()].sort((a, b) => a.dia.localeCompare(b.dia));
  return { leads: emOrdem(leads), ligacoes: emOrdem(ligacoes) };
}

/** Pedido para parar = bloqueio do contato até 48h depois do início do dia do envio. */
export function historicoDeEnvio(
  itens: readonly ItemDaFila[],
  enviados: ReadonlySet<string>,
  bloqueadoEm: ReadonlyMap<string, string>,
  fuso: string,
): DiaDeEnvio[] {
  const porDia = new Map<string, DiaDeEnvio>();
  for (const i of itens) {
    if (i.tipo !== "lead_antigo" || !enviados.has(i.id)) continue;
    const d = porDia.get(i.dia) ?? { dia: i.dia, enviados: 0, pedidosParaParar: 0 };
    d.enviados += 1;
    const bloqueio = bloqueadoEm.get(i.contactId);
    if (bloqueio) {
      const t = new Date(bloqueio).getTime();
      if (t >= inicioDoDia(i.dia, fuso).getTime() && t < inicioDoDia(somarDias(i.dia, 2), fuso).getTime()) {
        d.pedidosParaParar += 1;
      }
    }
    porDia.set(i.dia, d);
  }
  return [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia));
}

export function tamanhoDaFilaDeLeads(
  regras: RegrasDoBonus,
  historico: readonly DiaDeEnvio[],
): { tamanho: number; reduzida: boolean } {
  const { limite_bps, dias_seguidos, fracao_reduzida_bps } = regras.protecao;
  const base = regras.rotinas.leads_por_dia;
  const ultimos = historico
    .filter((d) => d.enviados > 0)
    .sort((a, b) => b.dia.localeCompare(a.dia))
    .slice(0, dias_seguidos);
  const reduzida =
    ultimos.length === dias_seguidos &&
    ultimos.every((d) => d.pedidosParaParar * 10_000 > limite_bps * d.enviados);
  return { tamanho: reduzida ? Math.floor((base * fracao_reduzida_bps) / 10_000) : base, reduzida };
}
