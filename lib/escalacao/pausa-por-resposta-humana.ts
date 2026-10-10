/**
 * QUANTO TEMPO A IA FICA FORA DA CONVERSA DEPOIS QUE UMA PESSOA RESPONDE.
 *
 * Um ajuste por organização, em `organizations.settings.atendimento
 * .pausa_ia_resposta_humana_min` (minutos). Vale para os DOIS caminhos em que
 * uma pessoa responde: pelo celular/canal (`pausarIaPorAtendimentoManual`) e
 * pela tela do CRM (`sendMessageHandler`). Eram duas constantes de 5 minutos,
 * uma em cada arquivo; agora as duas leem daqui.
 *
 * Padrão 5 minutos: quem não mexe (e todo clone antigo, que não tem a chave)
 * continua exatamente como estava. O motivo do 5 está em
 * `lib/escalacao/atendimento-manual.ts`.
 *
 * O resolvedor NUNCA lança e nunca devolve valor fora da faixa: ele roda em
 * toda ingestão de mensagem `fromMe`, e um jsonb torto não pode derrubar a
 * ingestão nem calar a IA por um prazo que ninguém escolheu.
 *
 * Módulo sem dependência de servidor de propósito: a tela importa os limites.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const PAUSA_PADRAO_MIN = 5;
export const PAUSA_MINIMA_MIN = 5;
export const PAUSA_MAXIMA_MIN = 24 * 60;

export const pausaPorRespostaHumanaSchema = z.number().int().min(PAUSA_MINIMA_MIN).max(PAUSA_MAXIMA_MIN);

/** Minutos em vigor para estes `settings`. Ausente, torto ou fora da faixa = padrão. */
export function lerPausaPorRespostaHumanaMin(settings: unknown): number {
  const bruto = (settings as { atendimento?: { pausa_ia_resposta_humana_min?: unknown } } | null | undefined)
    ?.atendimento?.pausa_ia_resposta_humana_min;
  const r = pausaPorRespostaHumanaSchema.safeParse(bruto);
  return r.success ? r.data : PAUSA_PADRAO_MIN;
}

/** Os `settings` com a pausa trocada, e SÓ ela: o resto do jsonb sobrevive. */
export function settingsComPausaPorRespostaHumana(settings: unknown, minutos: number): Record<string, unknown> {
  const atual = (settings as Record<string, unknown> | null) ?? {};
  const atendimento = (atual.atendimento as Record<string, unknown> | undefined) ?? {};
  return { ...atual, atendimento: { ...atendimento, pausa_ia_resposta_humana_min: minutos } };
}

/**
 * A pausa da organização, em milissegundos. Uma consulta por chave primária;
 * qualquer falha (erro, linha ausente, exceção) devolve o padrão. O chamador já
 * resolveu `organizationId` de fonte confiável.
 */
export async function carregarPausaPorRespostaHumanaMs(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<number> {
  let settings: unknown = null;
  try {
    const { data } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    settings = (data as { settings?: unknown } | null)?.settings;
  } catch {
    // padrão
  }
  return lerPausaPorRespostaHumanaMin(settings) * 60 * 1000;
}
