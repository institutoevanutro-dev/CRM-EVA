/**
 * Leitura dos eventos do funil num período, compartilhada pelo funil por origem e pelo resumo do Início.
 * Os critérios de cada contagem estão no topo de `funil-por-origem.ts`. Comparecimento é
 * `calendar_appointments.status = 'completed'`, contado por `starts_at`, sem o lançado por engano
 * (`excluded_at`) e sem a importação da agenda antiga.
 *
 * Service role: TODA consulta filtra a organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { lerPreferencias } from "@/lib/conversoes/preferencias";
import { leadsQueEntraramNoSinal } from "@/lib/conversoes/sinais-do-periodo";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";

export type Contato = { contactId: string | null };

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

export function emLotes<T>(xs: T[]): T[][] {
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

export async function lerEventosDoPeriodo(admin: SupabaseClient, org: string, de: string, ate: string) {
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

  const comparecimentos = await todas<{ contact_id: string | null }>((a, b) =>
    admin.from("calendar_appointments").select("contact_id").eq("organization_id", org).eq("status", "completed")
      .is("excluded_at", null).neq("source", "historical_import")
      .gte("starts_at", inicio).lt("starts_at", fim).order("id").range(a, b));

  const ct = (x: { contact_id: string | null }): Contato => ({ contactId: x.contact_id });
  return {
    leads: leads.map(ct),
    agendamentos: agendamentos.map(ct),
    sinais: sinais.map(ct),
    comparecimentos: comparecimentos.map(ct),
    ganhos: ganhos.map((x) => ({ contactId: x.contact_id, valueCents: x.value_cents == null ? null : Number(x.value_cents) })),
  };
}
