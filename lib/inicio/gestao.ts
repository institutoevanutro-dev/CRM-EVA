/**
 * "GESTÃO" — o que impede o CRM de funcionar direito. Só a rota decide quem vê
 * (manager/admin); estas funções não checam papel.
 *
 * O `detalhe` dos itens de configuração é um CÓDIGO (`sem_responsavel`, …): a
 * tela o traduz. O `titulo` é o nome do objeto, que não se traduz.
 */
import type { BudgetStatus } from "@/lib/ai/budget/check";
import type { createClient } from "@/lib/supabase/server";
import {
  janelaDeHoje,
  LIMITE_DE_ITENS,
  type Bloco,
  type ContextoDoInicio,
  type ItemDoBloco,
} from "./tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

export async function configuracaoPendente(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const agora = ctx.agora.toISOString();
  const [tipos, convites, canais, agentes] = await Promise.all([
    db
      .from("calendar_event_types")
      .select("id,name")
      .eq("organization_id", ctx.orgId)
      .eq("is_active", true)
      .is("default_owner_user_id", null)
      // Mais novo primeiro: o tipo que acabou de ser criado não some atrás de antigos.
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("team_invites")
      .select("id,email")
      .eq("organization_id", ctx.orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .lt("expires_at", agora)
      .limit(50),
    db
      .from("channel_sessions")
      .select("id,display_name,status")
      .eq("organization_id", ctx.orgId)
      .neq("status", "WORKING")
      .limit(50),
    db
      .from("ai_agents")
      .select("id,name")
      .eq("organization_id", ctx.orgId)
      .is("published_version_id", null)
      .is("archived_at", null)
      .limit(50),
  ]);
  if (tipos.error || convites.error || canais.error || agentes.error) return { ok: false };
  const itens: ItemDoBloco[] = [
    ...(tipos.data ?? []).map((t) => ({
      id: `tipo:${t.id}`,
      titulo: String(t.name),
      detalhe: "sem_responsavel",
      href: "/app/agenda",
    })),
    ...(canais.data ?? []).map((c) => ({
      id: `canal:${c.id}`,
      titulo: c.display_name ? String(c.display_name) : "WhatsApp",
      detalhe: "canal_fora",
      href: "/app/connections",
    })),
    ...(convites.data ?? []).map((i) => ({
      id: `convite:${i.id}`,
      titulo: String(i.email),
      detalhe: "convite_vencido",
      href: "/app/team",
    })),
    ...(agentes.data ?? []).map((a) => ({
      id: `agente:${a.id}`,
      titulo: String(a.name),
      detalhe: "agente_rascunho",
      href: `/app/ai/agents/${a.id}`,
    })),
  ];
  return { ok: true, total: itens.length, itens: itens.slice(0, LIMITE_DE_ITENS) };
}

export interface Numeros {
  conversasComPaciente: number;
  agendamentosCriados: number;
  leadsGanhos: number;
}

export async function numerosDeHoje(
  db: Db,
  ctx: ContextoDoInicio,
): Promise<{ ok: true; numeros: Numeros } | { ok: false }> {
  const { inicio, fim } = janelaDeHoje(ctx.agora, ctx.fuso);
  const contar = { count: "exact" as const, head: true };
  const [conv, ag, leads] = await Promise.all([
    db
      .from("conversations")
      .select("id", contar)
      .eq("organization_id", ctx.orgId)
      .eq("is_group", false)
      .gte("last_inbound_at", inicio)
      .lt("last_inbound_at", fim),
    db
      .from("calendar_appointments")
      .select("id", contar)
      .eq("organization_id", ctx.orgId)
      .gte("created_at", inicio)
      .lt("created_at", fim),
    db
      .from("crm_leads")
      .select("id", contar)
      .eq("organization_id", ctx.orgId)
      .eq("status", "won")
      .gte("closed_at", inicio)
      .lt("closed_at", fim),
  ]);
  if (conv.error || ag.error || leads.error) return { ok: false };
  return {
    ok: true,
    numeros: {
      conversasComPaciente: conv.count ?? 0,
      agendamentosCriados: ag.count ?? 0,
      leadsGanhos: leads.count ?? 0,
    },
  };
}

export type GastoDeIa =
  | { ok: true; consumidoCents: number; limiteCents: number | null }
  | { ok: false };

/**
 * Lê pela régua ÚNICA do mês (`getBudgetStatus` → `fn_gasto_de_ia_do_mes`), a
 * mesma da tela de Uso e do gate. A coluna `current_month_consumed_cents`
 * acumula sem zerar e mostraria meses de gasto como "no mês" (achado da
 * revisão). Os valores são centavos de DÓLAR; limite 0 = sem limite.
 * `ler` é injetado: a rota passa `getBudgetStatus`, o teste passa um dublê.
 */
export async function gastoDeIa(
  ctx: ContextoDoInicio,
  ler: (orgId: string) => Promise<Pick<BudgetStatus, "monthly_limit_cents" | "current_month_consumed_cents">>,
): Promise<GastoDeIa> {
  try {
    const b = await ler(ctx.orgId);
    return {
      ok: true,
      consumidoCents: Number(b.current_month_consumed_cents ?? 0),
      limiteCents: b.monthly_limit_cents > 0 ? b.monthly_limit_cents : null,
    };
  } catch {
    return { ok: false };
  }
}
