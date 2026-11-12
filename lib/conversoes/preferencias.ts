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
 *
 * `paginaMeta` / `wabaMeta` nascem VAZIOS: o ID da Página do Facebook (ou, sem
 * página, o da conta do WhatsApp Business) que a Meta exige junto do
 * `ctwa_clid` num evento `business_messaging` (porte do upstream #2098 — sem
 * um dos dois ela recusa com code 100, subcode 2804116). Id torto é lido como
 * vazio: id errado não é recusa melhor, é evento na conta de outra pessoa.
 */
import { z } from "zod";

export const MAXIMO_DE_ETAPAS_DE_SINAL = 20;

/** Id da Meta (Página ou WABA): só dígitos. A action que grava confere a MESMA forma. */
export const FORMA_DO_ID_META = /^\d{5,64}$/;
const idMeta = z.string().trim().regex(FORMA_DO_ID_META).nullable().catch(null).default(null);

const schema = z
  .object({
    somente_de_anuncio: z.boolean().catch(true).default(true),
    etapas_de_sinal_pago: z.array(z.string().uuid()).max(MAXIMO_DE_ETAPAS_DE_SINAL).catch([]).default([]),
    meta_page_id: idMeta,
    meta_whatsapp_business_account_id: idMeta,
  })
  .catch({ somente_de_anuncio: true, etapas_de_sinal_pago: [], meta_page_id: null, meta_whatsapp_business_account_id: null });

export interface PreferenciasDeConversao {
  somenteDeAnuncio: boolean;
  etapasDeSinalPago: string[];
  paginaMeta: string | null;
  wabaMeta: string | null;
}

export function lerPreferencias(settings: unknown): PreferenciasDeConversao {
  const bruto =
    settings && typeof settings === "object" ? (settings as Record<string, unknown>).conversoes : undefined;
  const lido = schema.parse(bruto ?? {});
  return {
    somenteDeAnuncio: lido.somente_de_anuncio,
    etapasDeSinalPago: lido.etapas_de_sinal_pago,
    paginaMeta: lido.meta_page_id,
    wabaMeta: lido.meta_whatsapp_business_account_id,
  };
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
  if (p.paginaMeta !== undefined) conversoes.meta_page_id = p.paginaMeta;
  if (p.wabaMeta !== undefined) conversoes.meta_whatsapp_business_account_id = p.wabaMeta;
  return { ...atual, conversoes };
}
