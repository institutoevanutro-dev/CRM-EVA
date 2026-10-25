/**
 * Funil por origem para o painel de anúncios: quantos leads, agendamentos,
 * sinais pagos e ganhos (com a receita) vieram de cada origem num período.
 * Só agregados: nenhum id, nome ou telefone sai daqui.
 *
 * Origem é do CONTATO, nesta ordem: anúncio da Meta, anúncio do Google
 * (`contacts.source_metadata.ad_platform`, primeiro toque), "Indicação" como
 * etiqueta ou como origem de algum lead do contato (a importação de planilha
 * grava a coluna "origem" ali), e o resto é orgânico.
 *
 * Cada contagem usa a data do próprio evento:
 *  - leads: `crm_leads.created_at`, sem os da importação de planilha marcada
 *    como tal. Planilha com coluna "origem" própria não deixa marca no lead e
 *    conta no dia em que foi importada (limite conhecido);
 *  - agendamentos: `calendar_appointments.created_at`, só o primeiro de cada
 *    cadeia de remarcação (`rescheduled_from_id` nulo), para remarcar não
 *    contar duas vezes; sem a importação da agenda antiga e sem o lançado por
 *    engano (`excluded_at`);
 *  - sinais: `lead.stage_changed` no `event_log` para uma etapa marcada como
 *    sinal pago em Configurações › Conversões, um por lead (o mesmo critério
 *    do aviso de sinal pago à plataforma);
 *  - ganhos: `crm_leads.closed_at` com `status = 'won'`, somando `value_cents`.
 *
 * Desenho: docs do painel-meta, `specs/2026-10-23-funil-por-origem-design.md`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerPreferencias } from "@/lib/conversoes/preferencias";
import { leadsQueEntraramNoSinal } from "@/lib/conversoes/sinais-do-periodo";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";

export type Origem = "meta" | "google" | "indicacao" | "organico";
export const ORIGENS: readonly Origem[] = ["meta", "google", "indicacao", "organico"];

export interface LinhaDoFunil {
  origem: Origem;
  leads: number;
  agendamentos: number;
  sinais: number;
  ganhos: number;
  ganhos_sem_valor: number;
  receita_cents: string;
}
export interface FunilPorOrigem { currency: "BRL"; origens: LinhaDoFunil[] }

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

export function origemDe({ adPlatform, tags }: { adPlatform: string | null; tags: string[] }): Origem {
  if (adPlatform === "meta_ads") return "meta";
  if (adPlatform === "google_ads") return "google";
  // `tags` leva também a origem (`source`) dos leads do contato.
  if (tags.some((t) => semAcento(t) === "indicacao")) return "indicacao";
  return "organico";
}

type Contato = { contactId: string | null };
export function montarFunil(
  e: { leads: Contato[]; agendamentos: Contato[]; sinais: Contato[]; ganhos: (Contato & { valueCents: number | null })[] },
  origens: ReadonlyMap<string, Origem>,
): FunilPorOrigem {
  const linhas = new Map(ORIGENS.map((o) => [o, { leads: 0, agendamentos: 0, sinais: 0, ganhos: 0, sem: 0, receita: 0n }]));
  const de = (c: Contato) => linhas.get((c.contactId && origens.get(c.contactId)) || "organico")!;
  for (const x of e.leads) de(x).leads += 1;
  for (const x of e.agendamentos) de(x).agendamentos += 1;
  for (const x of e.sinais) de(x).sinais += 1;
  for (const x of e.ganhos) {
    const l = de(x);
    l.ganhos += 1;
    if (x.valueCents && x.valueCents > 0) l.receita += BigInt(x.valueCents);
    else l.sem += 1;
  }
  return {
    currency: "BRL",
    origens: ORIGENS.map((origem) => {
      const l = linhas.get(origem)!;
      return { origem, leads: l.leads, agendamentos: l.agendamentos, sinais: l.sinais, ganhos: l.ganhos, ganhos_sem_valor: l.sem, receita_cents: l.receita.toString() };
    }),
  };
}

// ---------- Leitura (service role: TODA consulta filtra a organização) ----------

const PAGINA = 1000;
const LOTE = 200;

/** Lê todas as páginas: o PostgREST corta em 1000 linhas por pedido. */
async function todas<T>(consulta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const saida: T[] = [];
  for (let i = 0; ; i += PAGINA) {
    const { data, error } = await consulta(i, i + PAGINA - 1);
    if (error) throw new Error("funil_por_origem: leitura falhou");
    saida.push(...(data ?? []));
    if (!data || data.length < PAGINA) return saida;
  }
}

function emLotes<T>(xs: T[]): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < xs.length; i += LOTE) lotes.push(xs.slice(i, i + LOTE));
  return lotes;
}

/** Dia inteiro em São Paulo (sem horário de verão desde 2019). */
function janela(de: string, ate: string) {
  const fim = new Date(`${ate}T00:00:00-03:00`);
  fim.setUTCDate(fim.getUTCDate() + 1);
  return { inicio: new Date(`${de}T00:00:00-03:00`).toISOString(), fim: fim.toISOString() };
}

export async function consultaFunilPorOrigem(admin: SupabaseClient, org: string, de: string, ate: string): Promise<FunilPorOrigem> {
  const { inicio, fim } = janela(de, ate);

  const leads = await todas<{ contact_id: string | null }>((a, b) =>
    admin.from("crm_leads").select("contact_id").eq("organization_id", org).or(`source.is.null,source.neq.${ORIGEM_DA_PLANILHA}`).gte("created_at", inicio).lt("created_at", fim).order("id").range(a, b));

  const agendamentos = await todas<{ contact_id: string | null }>((a, b) =>
    admin.from("calendar_appointments").select("contact_id").eq("organization_id", org).is("rescheduled_from_id", null)
      .is("excluded_at", null).neq("source", "historical_import")
      .gte("created_at", inicio).lt("created_at", fim).order("id").range(a, b));

  const ganhos = await todas<{ contact_id: string | null; value_cents: number | null }>((a, b) =>
    admin.from("crm_leads").select("contact_id, value_cents").eq("organization_id", org).eq("status", "won")
      .gte("closed_at", inicio).lt("closed_at", fim).order("id").range(a, b));

  const { data: dataOrg, error: erroOrg } = await admin.from("organizations").select("settings").eq("id", org).maybeSingle();
  if (erroOrg) throw new Error("funil_por_origem: organização");
  const { etapasDeSinalPago } = lerPreferencias((dataOrg as { settings?: unknown } | null)?.settings);
  const sinais: { contact_id: string | null }[] = [];
  if (etapasDeSinalPago.length) {
    const leadsDoSinal = await leadsQueEntraramNoSinal(admin, org, etapasDeSinalPago, inicio, fim);
    for (const lote of emLotes(leadsDoSinal)) {
      const { data, error } = await admin.from("crm_leads").select("contact_id").eq("organization_id", org).in("id", lote);
      if (error) throw new Error("funil_por_origem: leads do sinal");
      sinais.push(...((data ?? []) as { contact_id: string | null }[]));
    }
  }

  // Origem de cada contato envolvido: plataforma do anúncio e etiquetas de todos os leads dele.
  const contatos = [...new Set([...leads, ...agendamentos, ...ganhos, ...sinais].map((x) => x.contact_id).filter((x): x is string => Boolean(x)))];
  const plataforma = new Map<string, string | null>();
  const etiquetas = new Map<string, string[]>();
  for (const lote of emLotes(contatos)) {
    const [c, l] = await Promise.all([
      admin.from("contacts").select("id, ad_platform:source_metadata->>ad_platform").eq("organization_id", org).in("id", lote),
      admin.from("crm_leads").select("contact_id, tags, source").eq("organization_id", org).in("contact_id", lote),
    ]);
    if (c.error || l.error) throw new Error("funil_por_origem: contatos");
    for (const x of (c.data ?? []) as { id: string; ad_platform: string | null }[]) plataforma.set(x.id, x.ad_platform);
    for (const x of (l.data ?? []) as { contact_id: string; tags: string[] | null; source: string | null }[])
      etiquetas.set(x.contact_id, [...(etiquetas.get(x.contact_id) ?? []), ...(x.tags ?? []), ...(x.source ? [x.source] : [])]);
  }
  const origens = new Map(contatos.map((id) => [id, origemDe({ adPlatform: plataforma.get(id) ?? null, tags: etiquetas.get(id) ?? [] })]));

  const ct = (x: { contact_id: string | null }) => ({ contactId: x.contact_id });
  return montarFunil({
    leads: leads.map(ct),
    agendamentos: agendamentos.map(ct),
    sinais: sinais.map(ct),
    ganhos: ganhos.map((x) => ({ contactId: x.contact_id, valueCents: x.value_cents == null ? null : Number(x.value_cents) })),
  }, origens);
}
