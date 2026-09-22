/**
 * "MEU DIA" — o que a pessoa logada precisa fazer hoje.
 *
 * Avisos da Central são da clínica TODA: `agent_inbox_items` não tem dono no
 * schema (spec, "Suposições"). Os outros três filtram pela pessoa.
 */
import type { createClient } from "@/lib/supabase/server";
import { janelaDeHoje, LIMITE_DE_ITENS, type Bloco, type ContextoDoInicio } from "./tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

const STATUS_DE_CONVERSA_ENCERRADA = ["resolved", "closed", "archived"];

export async function avisosAbertos(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { data, error } = await db
    .from("agent_inbox_items")
    .select("id,title,created_at")
    .eq("organization_id", ctx.orgId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((l) => ({
      id: String(l.id),
      titulo: String(l.title ?? ""),
      href: "/app/ai/inbox",
    })),
  };
}

export async function esperandoResposta(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  // PostgREST não compara duas colunas; traz as minhas com mensagem recebida e
  // filtra "a última é do paciente" aqui. 200 é folga: ninguém tem 200 conversas.
  const { data, error } = await db
    .from("conversations")
    .select("id,last_inbound_at,last_outbound_at,last_message_preview,status")
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to_user_id", ctx.userId)
    .eq("is_group", false)
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const esperando = (data ?? []).filter(
    (c) =>
      !STATUS_DE_CONVERSA_ENCERRADA.includes(String(c.status)) &&
      (c.last_outbound_at == null || String(c.last_inbound_at) > String(c.last_outbound_at)),
  );
  return {
    ok: true,
    total: esperando.length,
    itens: esperando.slice(0, LIMITE_DE_ITENS).map((c) => ({
      id: String(c.id),
      titulo: String(c.last_message_preview ?? ""),
      // `?id=` é o parâmetro que a Inbox lê (11 links no repo usam esse).
      href: `/app/inbox?id=${c.id}`,
    })),
  };
}

export async function agendaDeHoje(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { inicio, fim } = janelaDeHoje(ctx.agora, ctx.fuso);
  const { data, error } = await db
    .from("calendar_appointments")
    .select("id,title,starts_at,status")
    .eq("organization_id", ctx.orgId)
    .eq("owner_user_id", ctx.userId)
    .neq("status", "cancelled")
    .gte("starts_at", inicio)
    .lt("starts_at", fim)
    .order("starts_at", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((a) => ({
      id: String(a.id),
      titulo: String(a.title ?? ""),
      detalhe: String(a.starts_at),
      href: "/app/agenda",
    })),
  };
}

export async function minhasTarefas(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  const { dia } = janelaDeHoje(ctx.agora, ctx.fuso);
  const { data, error } = await db
    .from("crm_tasks")
    .select("id,title,due_date,status")
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to", ctx.userId)
    .in("status", ["pending", "in_progress"])
    .lte("due_date", dia)
    .order("due_date", { ascending: true })
    .limit(200);
  if (error) return { ok: false };
  const linhas = data ?? [];
  return {
    ok: true,
    total: linhas.length,
    itens: linhas.slice(0, LIMITE_DE_ITENS).map((t) => ({
      id: String(t.id),
      titulo: String(t.title ?? ""),
      ...(t.due_date ? { detalhe: String(t.due_date) } : {}),
      href: "/app/tasks",
    })),
  };
}
