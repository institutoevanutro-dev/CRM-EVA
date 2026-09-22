/**
 * "MEU DIA" — o que a pessoa logada precisa fazer hoje.
 *
 * Avisos da Central são da clínica TODA: `agent_inbox_items` não tem dono no
 * schema (spec, "Suposições"). Os outros três filtram pela pessoa.
 */
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { tagDeIdioma } from "@/lib/i18n/datas";
import type { createClient } from "@/lib/supabase/server";
import { janelaDeHoje, LIMITE_DE_ITENS, type Bloco, type ContextoDoInicio } from "./tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

const STATUS_DE_CONVERSA_ENCERRADA = ["resolved", "closed", "archived"];

/** "10:00" no fuso da clínica, no idioma de quem lê. */
function horaNoFuso(iso: string, ctx: ContextoDoInicio): string {
  return new Intl.DateTimeFormat(tagDeIdioma(ctx.idioma), {
    timeZone: ctx.fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** "21/09" no fuso da clínica, no idioma de quem lê. */
function diaNoFuso(iso: string, ctx: ContextoDoInicio): string {
  return new Intl.DateTimeFormat(tagDeIdioma(ctx.idioma), {
    timeZone: ctx.fuso,
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(iso));
}

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
  // Encerrar a conversa NÃO limpa `assigned_to_user_id` (fn_service_status), então
  // as fechadas se acumulam na pessoa. O corte de status fica NA QUERY — filtrado
  // depois do `limit`, quem tem 200+ fechadas veria "Tudo em dia" com paciente
  // esperando (achado da revisão). "A última é do paciente" compara duas colunas,
  // o que o PostgREST não faz; isso sim fica aqui, sobre as mais recentes.
  const { data, error } = await db
    .from("conversations")
    .select(
      "id,last_inbound_at,last_outbound_at,last_message_preview,contact:contacts(name,display_name,phone_number)",
    )
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to_user_id", ctx.userId)
    .eq("is_group", false)
    .not("status", "in", `(${STATUS_DE_CONVERSA_ENCERRADA.join(",")})`)
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false };
  const esperando = (data ?? []).filter(
    (c) =>
      c.last_outbound_at == null ||
      Date.parse(String(c.last_inbound_at)) > Date.parse(String(c.last_outbound_at)),
  );
  return {
    ok: true,
    total: esperando.length,
    itens: esperando.slice(0, LIMITE_DE_ITENS).map((c) => ({
      id: String(c.id),
      titulo:
        nomeDoContato(Array.isArray(c.contact) ? c.contact[0] : c.contact) ??
        String(c.last_message_preview ?? ""),
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
      detalhe: horaNoFuso(String(a.starts_at), ctx),
      href: "/app/agenda",
    })),
  };
}

export async function minhasTarefas(db: Db, ctx: ContextoDoInicio): Promise<Bloco> {
  // `due_date` é timestamptz (a tela grava data + hora): "até o fim de hoje".
  const { fim } = janelaDeHoje(ctx.agora, ctx.fuso);
  const { data, error } = await db
    .from("crm_tasks")
    .select("id,title,due_date,status")
    .eq("organization_id", ctx.orgId)
    .eq("assigned_to", ctx.userId)
    .in("status", ["pending", "in_progress"])
    .lt("due_date", fim)
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
      ...(t.due_date ? { detalhe: diaNoFuso(String(t.due_date), ctx) } : {}),
      href: "/app/tasks",
    })),
  };
}
