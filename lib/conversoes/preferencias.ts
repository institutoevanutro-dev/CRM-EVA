/**
 * As preferências de conversão da ORGANIZAÇÃO — o que vale para todas as
 * plataformas. Mora em `organizations.settings.conversoes`, lida só por aqui.
 *
 * `somenteDeAnuncio` nasce LIGADO: só paciente que chegou por anúncio vira
 * aviso. O paciente orgânico não tem por que ir para plataforma de anúncio
 * nenhuma, e desligar isto é decisão de quem administra, na tela.
 *
 * `etapasDeSinalPago` nasce VAZIA: são as etapas do funil que querem dizer "o
 * sinal foi pago". Sem etapa marcada, o evento de sinal pago nunca sai. Só o id
 * da etapa é guardado; o nome dela nunca sai para plataforma nenhuma. A action
 * que grava confere que cada id é etapa da própria organização.
 */
import { z } from "zod";

export const MAXIMO_DE_ETAPAS_DE_SINAL = 20;

const schema = z
  .object({
    somente_de_anuncio: z.boolean().catch(true).default(true),
    etapas_de_sinal_pago: z.array(z.string().uuid()).max(MAXIMO_DE_ETAPAS_DE_SINAL).catch([]).default([]),
  })
  .catch({ somente_de_anuncio: true, etapas_de_sinal_pago: [] });

export interface PreferenciasDeConversao {
  somenteDeAnuncio: boolean;
  etapasDeSinalPago: string[];
}

export function lerPreferencias(settings: unknown): PreferenciasDeConversao {
  const bruto =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>).conversoes : undefined;
  const lido = schema.parse(bruto ?? {});
  return { somenteDeAnuncio: lido.somente_de_anuncio, etapasDeSinalPago: lido.etapas_de_sinal_pago };
}

/** O `settings` com as preferências informadas gravadas, sem tocar nas outras chaves. */
export function settingsComPreferencias(
  settings: unknown,
  p: Partial<PreferenciasDeConversao>,
): Record<string, unknown> {
  const atual = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const conversoes: Record<string, unknown> =
    atual.conversoes && typeof atual.conversoes === "object" ? { ...(atual.conversoes as Record<string, unknown>) } : {};
  if (p.somenteDeAnuncio !== undefined) conversoes.somente_de_anuncio = p.somenteDeAnuncio;
  if (p.etapasDeSinalPago !== undefined) conversoes.etapas_de_sinal_pago = p.etapasDeSinalPago;
  return { ...atual, conversoes };
}
