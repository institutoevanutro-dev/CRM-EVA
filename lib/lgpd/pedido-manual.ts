/**
 * O pedido que a EQUIPE registra pela tela: o titular pediu por WhatsApp, e-mail,
 * telefone ou no balcão, e alguém precisa pôr isso no sistema para o prazo contar.
 *
 * Só validação e data, sem banco: a rota e o formulário usam o mesmo esquema.
 */
import { z } from "zod";

import {
  LGPD_CANAIS_DE_CHEGADA,
  LGPD_FORMAS_DE_ENTREGA,
  LGPD_TIPOS_REGISTRAVEIS,
} from "./types";

/**
 * O dia civil de hoje, `YYYY-MM-DD`, no Brasil.
 *
 * ponytail: fuso fixo em São Paulo, como o calendário de feriados de `sla.ts`.
 * Se o produto ganhar fuso por organização, ele entra aqui.
 */
export function hojeNoBrasil(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}

/** `YYYY-MM-DD` que existe no calendário (o regex sozinho aceita 2026-02-31). */
function diaValido(dia: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
  const d = new Date(`${dia}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dia;
}

/**
 * O instante gravado em `received_at` para o dia em que o titular pediu.
 *
 * Meio-dia UTC, sempre: é o mesmo dia civil em UTC (o eixo em que `computeDueAt`
 * conta o prazo) e no Brasil (09h, o eixo em que a tela mostra a data). Meia-noite
 * UTC apareceria na tela como a noite do dia anterior.
 */
export function instanteDoRecebimento(dia: string): Date {
  return new Date(`${dia}T12:00:00Z`);
}

export const registrarPedidoSchema = z.object({
  contact_id: z.string().uuid(),
  request_type: z.enum(LGPD_TIPOS_REGISTRAVEIS),
  channel: z.enum(LGPD_CANAIS_DE_CHEGADA),
  /** O dia em que o titular PEDIU. O prazo legal conta daqui, não de quando se digitou. */
  received_on: z.string().refine(diaValido, "Data inválida."),
  delivery_email: z.string().trim().toLowerCase().email().max(254).nullish(),
  note: z.string().trim().max(1000).nullish(),
});
export type RegistrarPedidoInput = z.infer<typeof registrarPedidoSchema>;

export const marcarEntregueSchema = z.object({
  method: z.enum(LGPD_FORMAS_DE_ENTREGA),
  note: z.string().trim().max(500).nullish(),
});
export type MarcarEntregueInput = z.infer<typeof marcarEntregueSchema>;
