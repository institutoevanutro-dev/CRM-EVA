/**
 * Funil por origem para o painel de anúncios: quantos leads, agendamentos,
 * sinais pagos e ganhos (com a receita) vieram de cada origem num período.
 * Só agregados: nenhum id, nome ou telefone sai daqui.
 *
 * Origem é do CONTATO, nesta ordem: anúncio da Meta, anúncio do Google
 * (`contacts.source_metadata.ad_platform`, primeiro toque), as etiquetas "Meta" e "Google" postas à mão
 * (ou "Anúncio Meta"/"Anúncio Google"), "Indicação" como
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
 *  - ganhos: `crm_leads.closed_at` com `status = 'won'`, somando `value_cents`;
 *  - comparecimentos: consultas `completed` por `starts_at` (`lerComparecimentos`, a mesma régua do resumo).
 *
 * A leitura desses eventos mora em `eventos-do-periodo.ts`, compartilhada com o resumo do Início.
 *
 * Vendas (16/11, para CAC e ROAS por canal): com o Financeiro ligado, cada origem leva também
 * `vendido_cents` (o VENDIDO no período, parcelado inclusive, decisão do André) e `compradores`
 * (contatos com venda no período). Os contatos são os mesmos do funil (com algum evento no período);
 * quem comprou sem nenhum evento no CRM no período não entra (limite conhecido). Sem o Financeiro, ou
 * com ele fora do ar, os dois campos não vêm e o painel segue com a receita dos ganhos.
 *
 * Desenho: docs do painel-meta, `specs/2026-10-23-funil-por-origem-design.md`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emLotes, lerComparecimentos, lerEventosDoPeriodo, type Contato } from "@/lib/integrations/marketing/eventos-do-periodo";
import type { VendaPorContato } from "@/lib/integrations/financeiro/cliente";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { origemDe, origemInformadaDe, type OrigemInformada } from "@/lib/contacts/origem-informada";

const UUID_RFC = z.string().uuid();

/** Pede as vendas por contato em lotes de 500 (o limite da rota do Financeiro). */
export type ConsultaVendas = (contatos: string[]) => Promise<VendaPorContato[]>;

/** Soma, por origem, o vendido e quantos contatos compraram. */
export function somarVendasPorOrigem(vendas: VendaPorContato[], origens: ReadonlyMap<string, Origem>) {
  const s = new Map(ORIGENS.map((o) => [o, { vendido: 0n, compradores: 0 }]));
  for (const v of vendas) {
    if (!(v.vendas > 0)) continue;
    const l = s.get(origens.get(v.contato_id) ?? "organico")!;
    l.vendido += BigInt(v.valor_cents);
    l.compradores += 1;
  }
  return s;
}

export type Origem = "meta" | "google" | "indicacao" | "organico";
export const ORIGENS: readonly Origem[] = ["meta", "google", "indicacao", "organico"];

export interface LinhaDoFunil {
  origem: Origem;
  /** Só com o Financeiro ligado e respondendo. */
  vendido_cents?: string;
  compradores?: number;
  leads: number;
  agendamentos: number;
  comparecimentos: number;
  sinais: number;
  ganhos: number;
  ganhos_sem_valor: number;
  receita_cents: string;
}
export interface FunilPorOrigem { currency: "BRL"; origens: LinhaDoFunil[] }

// A regra mora em `lib/contacts/origem-informada.ts` desde 21/11/2026: o
// "Novo agendamento" da Agenda mostra a MESMA origem que o funil conta.
export { origemDe };

export function montarFunil(
  e: { leads: Contato[]; agendamentos: Contato[]; comparecimentos?: Contato[]; sinais: Contato[]; ganhos: (Contato & { valueCents: number | null })[] },
  origens: ReadonlyMap<string, Origem>,
): FunilPorOrigem {
  const linhas = new Map(ORIGENS.map((o) => [o, { leads: 0, agendamentos: 0, comparecimentos: 0, sinais: 0, ganhos: 0, sem: 0, receita: 0n }]));
  const de = (c: Contato) => linhas.get((c.contactId && origens.get(c.contactId)) || "organico")!;
  for (const x of e.leads) de(x).leads += 1;
  for (const x of e.agendamentos) de(x).agendamentos += 1;
  for (const x of e.comparecimentos ?? []) de(x).comparecimentos += 1;
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
      return { origem, leads: l.leads, agendamentos: l.agendamentos, comparecimentos: l.comparecimentos, sinais: l.sinais, ganhos: l.ganhos, ganhos_sem_valor: l.sem, receita_cents: l.receita.toString() };
    }),
  };
}

// ---------- Leitura (service role: TODA consulta filtra a organização) ----------

export async function consultaFunilPorOrigem(admin: SupabaseClient, org: string, de: string, ate: string, vendas?: ConsultaVendas): Promise<FunilPorOrigem> {
  const [{ leads, agendamentos, sinais, ganhos }, comparecimentos] = await Promise.all([
    lerEventosDoPeriodo(admin, org, de, ate),
    lerComparecimentos(admin, org, de, ate),
  ]);

  // Origem de cada contato envolvido: plataforma do anúncio e etiquetas de todos os leads dele.
  const contatos = [...new Set([...leads, ...agendamentos, ...comparecimentos, ...ganhos, ...sinais].map((x) => x.contactId).filter((x): x is string => Boolean(x)))];
  const plataforma = new Map<string, string | null>();
  const etiquetas = new Map<string, string[]>();
  const informadas = new Map<string, OrigemInformada | null>();
  for (const lote of emLotes(contatos)) {
    const [c, l] = await Promise.all([
      admin.from("contacts").select("id, source_metadata").eq("organization_id", org).in("id", lote),
      admin.from("crm_leads").select("contact_id, tags, source").eq("organization_id", org).in("contact_id", lote),
    ]);
    if (c.error || l.error) throw new Error("funil_por_origem: contatos");
    for (const x of (c.data ?? []) as { id: string; source_metadata: Record<string, unknown> | null }[]) {
      const ad = x.source_metadata?.ad_platform;
      plataforma.set(x.id, typeof ad === "string" ? ad : null);
      informadas.set(x.id, origemInformadaDe(x.source_metadata));
    }
    for (const x of (l.data ?? []) as { contact_id: string; tags: string[] | null; source: string | null }[])
      etiquetas.set(x.contact_id, [...(etiquetas.get(x.contact_id) ?? []), ...(x.tags ?? []), ...(x.source ? [x.source] : [])]);
  }
  const origens = new Map(contatos.map((id) => [id, origemDe({ adPlatform: plataforma.get(id) ?? null, tags: etiquetas.get(id) ?? [], informada: informadas.get(id) ?? null })]));

  const funil = montarFunil({ leads, agendamentos, comparecimentos, sinais, ganhos }, origens);
  // Só ids no formato que a rota do Financeiro aceita (UUID RFC). Contato antigo com id fora do formato
  // derrubava a consulta inteira (17/11: 2 de ~600 contatos, e o funil de 30 dias saía sem vendas).
  // Esses poucos ficam fora da soma; nenhum outro se perde.
  const aceitos = contatos.filter((id) => UUID_RFC.safeParse(id).success);
  if (!vendas || !aceitos.length) return funil;
  let s: ReturnType<typeof somarVendasPorOrigem>;
  try {
    const todas: VendaPorContato[] = [];
    for (let i = 0; i < aceitos.length; i += 500) todas.push(...(await vendas(aceitos.slice(i, i + 500))));
    // A soma fica DENTRO do try: um valor_cents fora do formato (BigInt lança) não derruba o funil inteiro.
    s = somarVendasPorOrigem(todas, origens);
  } catch (err) {
    logger.warn("funil_por_origem: vendas do Financeiro indisponíveis", { org, error: err instanceof Error ? err.message : String(err) });
    return funil; // Financeiro fora: o funil sai sem as vendas, nunca com zero inventado
  }
  return { ...funil, origens: funil.origens.map((l) => ({ ...l, vendido_cents: s.get(l.origem)!.vendido.toString(), compradores: s.get(l.origem)!.compradores })) };
}
