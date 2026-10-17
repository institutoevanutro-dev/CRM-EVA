/**
 * "MEU DIA" — o que a pessoa logada precisa fazer hoje, e SÓ o que é dela.
 *
 * Conversas, agenda e tarefas filtram pela pessoa na própria coluna de dono.
 * Avisos da Central não têm dono no schema (`agent_inbox_items` aponta para uma
 * referência polimórfica), então o dono é DERIVADO da referência — regra em
 * `escopoDoAviso` e `avisoChegaAQuem`, abaixo, e em
 * docs/superpowers/specs/2026-10-17-inicio-por-pessoa.md.
 */
import { roleAtLeast } from "@/lib/auth/types";
import { COLUNA_DO_OCULTO } from "@/lib/inbox/contato-oculto";
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

/**
 * DE QUEM É UM AVISO DA CENTRAL.
 *
 * - `meu`: a referência (conversa, compromisso, caso, follow-up, contato) tem a
 *   pessoa como dona — atendente da conversa, profissional do compromisso, dono
 *   do lead do contato.
 * - `de_outra_pessoa`: a referência tem dono, e não é ela.
 * - `sem_dono`: a referência é de uma pessoa (paciente), mas ninguém assumiu —
 *   ou ela não existe mais.
 * - `organizacao`: o aviso é da operação (canal fora, orçamento de IA, fila
 *   morta, escalação de LGPD…), mesmo quando cita uma conversa como exemplo.
 */
export type EscopoDoAviso = "meu" | "de_outra_pessoa" | "sem_dono" | "organizacao";

/** Referências que apontam para um paciente e, por ele, para quem o atende. */
const REFERENCIAS_DE_PESSOA = new Set(["conversation", "appointment", "agent_case", "followup_enrollment", "contact"]);
/** Tipos que usam a conversa só como EXEMPLO de um defeito da organização (o mesmo corte da anonimização). */
const TIPOS_DA_ORGANIZACAO = new Set(["message_send_stuck", "capabilities_missing"]);

export function escopoDoAviso(
  aviso: { kind: string | null; ref_kind: string | null; ref_id: string | null },
  donosPorReferencia: Map<string, Set<string>>,
  userId: string,
): EscopoDoAviso {
  if (!aviso.ref_id || !aviso.ref_kind || !REFERENCIAS_DE_PESSOA.has(aviso.ref_kind)) return "organizacao";
  if (aviso.kind && TIPOS_DA_ORGANIZACAO.has(aviso.kind)) return "organizacao";
  const donos = donosPorReferencia.get(aviso.ref_id);
  if (!donos || donos.size === 0) return "sem_dono";
  return donos.has(userId) ? "meu" : "de_outra_pessoa";
}

/**
 * Quem recebe o aviso no "Meu dia": o dono, sempre; o que é da organização ou
 * de ninguém, só gerente e admin. O de outra pessoa não chega a ninguém aqui —
 * continua na Central, que é a lista da equipe toda.
 */
export function avisoChegaAQuem(escopo: EscopoDoAviso, papel: string): boolean {
  if (escopo === "meu") return true;
  if (escopo === "de_outra_pessoa") return false;
  // Leitura de rank que não decide 401/403 (o gate é o requireRole da rota).
  return roleAtLeast(papel, "manager");
}

/** `.in()` vai na URL: fatias pequenas mantêm a requisição abaixo do limite do proxy. */
function fatias(ids: Iterable<string>, tamanho = 100): string[][] {
  const lista = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) out.push(lista.slice(i, i + tamanho));
  return out;
}

type Linha = Record<string, unknown>;
async function buscarPorIds(db: Db, tabela: string, colunas: string, coluna: string, ids: Iterable<string>, orgId: string) {
  const respostas = await Promise.all(
    fatias(ids).map((lote) =>
      db.from(tabela as never).select(colunas).eq("organization_id", orgId).in(coluna, lote),
    ),
  );
  const erro = respostas.find((r) => r.error);
  if (erro) throw new Error(String(erro.error?.message));
  return respostas.flatMap((r) => (r.data ?? []) as unknown as Linha[]);
}

/**
 * Os donos de cada referência, em no máximo duas rodadas de consultas em lote
 * (nunca uma por aviso). Contato e follow-up resolvem pelo contato: quem atende
 * alguma conversa dele, ou é dono de um lead aberto dele.
 */
async function donosDasReferencias(
  db: Db,
  orgId: string,
  avisos: Array<{ ref_kind: string | null; ref_id: string | null }>,
): Promise<Map<string, Set<string>>> {
  const porTipo = (tipo: string) => avisos.filter((a) => a.ref_kind === tipo && a.ref_id).map((a) => a.ref_id!);
  const donos = new Map<string, Set<string>>();
  const dar = (ref: string, dono: unknown) => {
    const s = donos.get(ref) ?? new Set<string>();
    if (typeof dono === "string" && dono) s.add(dono);
    donos.set(ref, s);
  };

  const [conversas, consultas, casos, followups] = await Promise.all([
    buscarPorIds(db, "conversations", "id,assigned_to_user_id", "id", porTipo("conversation"), orgId),
    buscarPorIds(db, "calendar_appointments", "id,owner_user_id", "id", porTipo("appointment"), orgId),
    buscarPorIds(db, "agent_cases", "id,conversation_id", "id", porTipo("agent_case"), orgId),
    buscarPorIds(db, "followup_enrollments", "id,contact_id", "id", porTipo("followup_enrollment"), orgId),
  ]);
  for (const c of conversas) dar(String(c.id), c.assigned_to_user_id);
  for (const a of consultas) dar(String(a.id), a.owner_user_id);

  // Contato (direto ou pelo follow-up) → o contato de cada referência.
  const contatoDe = new Map<string, string[]>();
  for (const id of porTipo("contact")) contatoDe.set(id, [...(contatoDe.get(id) ?? []), id]);
  for (const f of followups) {
    const ct = String(f.contact_id);
    contatoDe.set(ct, [...(contatoDe.get(ct) ?? []), String(f.id)]);
  }
  // Uma conversa pode ter mais de um caso aberto: cada um herda o atendente dela.
  const casosDaConversa = new Map<string, string[]>();
  for (const c of casos) {
    const cv = String(c.conversation_id);
    casosDaConversa.set(cv, [...(casosDaConversa.get(cv) ?? []), String(c.id)]);
  }

  const [conversasDosCasos, conversasDosContatos, leadsDosContatos] = await Promise.all([
    buscarPorIds(db, "conversations", "id,assigned_to_user_id", "id", casosDaConversa.keys(), orgId),
    buscarPorIds(db, "conversations", "contact_id,assigned_to_user_id", "contact_id", contatoDe.keys(), orgId),
    buscarPorIds(db, "crm_leads", "contact_id,owner_user_id,status", "contact_id", contatoDe.keys(), orgId),
  ]);
  for (const c of conversasDosCasos)
    for (const caso of casosDaConversa.get(String(c.id)) ?? []) dar(caso, c.assigned_to_user_id);
  for (const id of casos.map((c) => String(c.id))) dar(id, null);
  for (const refs of contatoDe.values()) for (const ref of refs) dar(ref, null);
  for (const c of conversasDosContatos)
    for (const ref of contatoDe.get(String(c.contact_id)) ?? []) dar(ref, c.assigned_to_user_id);
  for (const l of leadsDosContatos.filter((l) => l.status === "open"))
    for (const ref of contatoDe.get(String(l.contact_id)) ?? []) dar(ref, l.owner_user_id);
  return donos;
}

export async function avisosAbertos(db: Db, ctx: ContextoDoInicio, limite = LIMITE_DE_ITENS): Promise<Bloco> {
  // ponytail: lê até 1000 avisos abertos (teto do PostgREST) e filtra aqui. Numa
  // organização com mais que isso abertos, os mais antigos ficam fora da conta;
  // se acontecer, o conserto é uma função no banco que faça o mesmo filtro.
  const { data, error } = await db
    .from("agent_inbox_items")
    .select("id,title,kind,ref_kind,ref_id,created_at")
    .eq("organization_id", ctx.orgId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return { ok: false };
  const linhas = data ?? [];
  const donos = await donosDasReferencias(db, ctx.orgId, linhas);
  const meus = linhas
    .map((l) => ({ l, escopo: escopoDoAviso(l, donos, ctx.userId) }))
    .filter(({ escopo }) => avisoChegaAQuem(escopo, ctx.papel));
  return {
    ok: true,
    total: meus.length,
    itens: meus.slice(0, limite).map(({ l, escopo }) => ({
      id: String(l.id),
      titulo: String(l.title ?? ""),
      detalhe: escopo,
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
    // Contato oculto do Inbox (migration 0372) não é paciente esperando.
    .eq(COLUNA_DO_OCULTO, false)
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
    // Lançado por engano ou de teste some da agenda (migration 0364).
    .is("excluded_at", null)
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
