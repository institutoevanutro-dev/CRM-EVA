/**
 * As preferências de conversão da ORGANIZAÇÃO — o que vale para todas as
 * plataformas. Mora em `organizations.settings.conversoes`, lida só por aqui.
 *
 * `somenteDeAnuncio` nasce LIGADO: só paciente que chegou por anúncio vira
 * aviso. O paciente orgânico não tem por que ir para plataforma de anúncio
 * nenhuma, e desligar isto é decisão de quem administra, na tela.
 */
import { z } from "zod";

const schema = z
  .object({ somente_de_anuncio: z.boolean().catch(true).default(true) })
  .catch({ somente_de_anuncio: true });

export interface PreferenciasDeConversao {
  somenteDeAnuncio: boolean;
}

export function lerPreferencias(settings: unknown): PreferenciasDeConversao {
  const bruto =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>).conversoes : undefined;
  return { somenteDeAnuncio: schema.parse(bruto ?? {}).somente_de_anuncio };
}

/** O `settings` com as preferências gravadas, sem tocar nas outras chaves. */
export function settingsComPreferencias(settings: unknown, p: PreferenciasDeConversao): Record<string, unknown> {
  const atual = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const conversoes =
    atual.conversoes && typeof atual.conversoes === "object" ? (atual.conversoes as Record<string, unknown>) : {};
  return { ...atual, conversoes: { ...conversoes, somente_de_anuncio: p.somenteDeAnuncio } };
}
