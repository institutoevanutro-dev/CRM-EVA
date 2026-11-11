/**
 * Resumo para a página Início do painel de anúncios: totais do funil da clínica num período, os mesmos números
 * por anúncio da Meta (primeiro toque do contato) e quantos leads não têm código de anúncio da Meta (Google,
 * indicação, orgânico, Meta sem código, sem contato): `leads_sem_anuncio + Σ por_anuncio.leads = totais.leads`.
 * Só agregados e o código do anúncio saem daqui. Desenho: painel-meta, specs/2026-11-10-resumo-no-inicio-design.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emLotes, lerComparecimentos, lerEventosDoPeriodo, type Contato } from "@/lib/integrations/marketing/eventos-do-periodo";

export interface Numeros { leads: number; agendamentos: number; comparecimentos: number; sinais: number; ganhos: number; ganhos_sem_valor: number; receita_cents: string }
export interface Resumo { currency: "BRL"; totais: Numeros; por_anuncio: (Numeros & { anuncio: string })[]; leads_sem_anuncio: number }

/** Código do anúncio da Meta: `sourceId` (WAHA, camelCase) ou `source_id` (API oficial). Post impulsionado não conta. */
const CODIGO = /^\d{10,20}$/;
export function anuncioDe({ adPlatform, adRaw }: { adPlatform: string | null; adRaw: unknown }): string | null {
  if (adPlatform !== "meta_ads" || !adRaw || typeof adRaw !== "object") return null;
  const r = adRaw as Record<string, unknown>;
  if (r.source_type === "post" || r.sourceType === "post") return null;
  const s = typeof r.sourceId === "string" ? r.sourceId : typeof r.source_id === "string" ? r.source_id : null;
  return s && CODIGO.test(s) ? s : null;
}

type Soma = { leads: number; agendamentos: number; comparecimentos: number; sinais: number; ganhos: number; sem: number; receita: bigint };
const zero = (): Soma => ({ leads: 0, agendamentos: 0, comparecimentos: 0, sinais: 0, ganhos: 0, sem: 0, receita: 0n });
const saida = (s: Soma): Numeros => ({ leads: s.leads, agendamentos: s.agendamentos, comparecimentos: s.comparecimentos, sinais: s.sinais, ganhos: s.ganhos, ganhos_sem_valor: s.sem, receita_cents: s.receita.toString() });

export function montarResumo(
  e: { leads: Contato[]; agendamentos: Contato[]; comparecimentos: Contato[]; sinais: Contato[]; ganhos: (Contato & { valueCents: number | null })[] },
  anuncios: ReadonlyMap<string, string>,
): Resumo {
  const total = zero();
  const porAnuncio = new Map<string, Soma>();
  const de = (c: Contato) => {
    const a = c.contactId ? anuncios.get(c.contactId) : undefined;
    if (!a) return null;
    let s = porAnuncio.get(a);
    if (!s) porAnuncio.set(a, (s = zero()));
    return s;
  };
  for (const k of ["leads", "agendamentos", "comparecimentos", "sinais"] as const)
    for (const x of e[k]) { total[k] += 1; const s = de(x); if (s) s[k] += 1; }
  for (const x of e.ganhos) {
    const valor = x.valueCents && x.valueCents > 0 ? BigInt(x.valueCents) : null;
    for (const s of [total, de(x)]) {
      if (!s) continue;
      s.ganhos += 1;
      if (valor) s.receita += valor; else s.sem += 1;
    }
  }
  const leads_sem_anuncio = e.leads.filter((x) => !x.contactId || !anuncios.has(x.contactId)).length;
  return {
    currency: "BRL",
    totais: saida(total),
    por_anuncio: [...porAnuncio].map(([anuncio, s]) => ({ anuncio, ...saida(s) })),
    leads_sem_anuncio,
  };
}

// Service role: TODA consulta filtra a organização.
export async function consultaResumo(admin: SupabaseClient, org: string, de: string, ate: string): Promise<Resumo> {
  const eventos = { ...(await lerEventosDoPeriodo(admin, org, de, ate)), comparecimentos: await lerComparecimentos(admin, org, de, ate) };
  const contatos = [...new Set(Object.values(eventos).flat().map((x) => x.contactId).filter((x): x is string => Boolean(x)))];
  const anuncios = new Map<string, string>();
  for (const lote of emLotes(contatos)) {
    const { data, error } = await admin.from("contacts")
      .select("id, ad_platform:source_metadata->>ad_platform, ad_raw:source_metadata->ad_raw")
      .eq("organization_id", org).in("id", lote);
    if (error) throw new Error("resumo: contatos");
    for (const c of (data ?? []) as { id: string; ad_platform: string | null; ad_raw: unknown }[]) {
      const a = anuncioDe({ adPlatform: c.ad_platform, adRaw: c.ad_raw });
      if (a) anuncios.set(c.id, a);
    }
  }
  return montarResumo(eventos, anuncios);
}
