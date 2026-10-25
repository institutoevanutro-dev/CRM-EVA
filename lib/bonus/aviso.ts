/**
 * O aviso de que a fila de leads antigos diminuiu para proteger o número.
 * A Central é lida pela organização inteira: o texto não leva nome, valor nem
 * percentual de ninguém, só contagens da regra. Um aviso aberto por programa:
 * enquanto não for resolvido, não nasce outro. Sai no idioma da organização,
 * porque a Central mostra título e corpo como foram gravados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import type { ProgramaDoBonus } from "./fatos";

export const REF_KIND_PROTECAO_DA_FILA = "bonus_protecao_da_fila";

const TITULO = "A fila de leads antigos foi reduzida";
const CORPO =
  "Os pedidos para parar de receber mensagens passaram do limite em {d} dias seguidos. " +
  "Hoje cada pessoa recebe {n} leads antigos em vez de {m}. " +
  "A fila volta ao tamanho normal sozinha quando os pedidos caírem. Confira em Análise › Bônus.";

export async function avisarFilaReduzida(
  admin: SupabaseClient,
  programa: ProgramaDoBonus,
  tamanho: number,
): Promise<void> {
  const { data: aberto, error: erroLeitura } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", programa.organizationId)
    .eq("kind", "other")
    .eq("ref_kind", REF_KIND_PROTECAO_DA_FILA)
    .eq("ref_id", programa.id)
    .eq("status", "open")
    .limit(1);
  if (erroLeitura) {
    logger.error("[bonus.aviso] leitura do aviso aberto falhou", { organization_id: programa.organizationId });
    return;
  }
  if ((aberto ?? []).length > 0) return;

  const { data: org } = await admin
    .from("organizations")
    .select("locale")
    .eq("id", programa.organizationId)
    .maybeSingle();
  const idioma = normalizarIdioma((org as { locale?: string | null } | null)?.locale);

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: programa.organizationId,
    kind: "other",
    severity: "warn",
    title: traduzir(TITULO, idioma),
    body: traduzir(CORPO, idioma)
      .replace("{d}", String(programa.regras.protecao.dias_seguidos))
      .replace("{n}", String(tamanho))
      .replace("{m}", String(programa.regras.rotinas.leads_por_dia)),
    ref_kind: REF_KIND_PROTECAO_DA_FILA,
    ref_id: programa.id,
  });
  if (error) logger.error("[bonus.aviso] aviso não foi aberto", { organization_id: programa.organizationId, error: error.message });
}
