/**
 * "MEU DIA" — o que a pessoa logada precisa fazer hoje: o que é DELA e, nas
 * conversas, também a fila sem responsável (que qualquer um pode assumir).
 *
 * Agenda e tarefas filtram pela pessoa na própria coluna de dono; quem espera
 * resposta é contado no banco (`fn_inicio_esperando`), sob a RLS de quem lê.
 * Avisos da Central não têm dono no schema (`agent_inbox_items` aponta para uma
 * referência polimórfica), então o dono é DERIVADO da referência — regra em
 * `escopoDoAviso` e `avisoChegaAQuem`, abaixo, e em
 * docs/superpowers/specs/2026-10-17-inicio-por-pessoa.md. O que mudou em
 * 2026-11-11 está em docs/superpowers/specs/2026-11-11-inicio-claro.md.
 */
import { KIND_LABEL } from "@/lib/ai/agent-inbox-copy";
import { roleAtLeast } from "@/lib/auth/types";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { createClient } from "@/lib/supabase/server";
import {
  corteDaEsperaRecente,
  janelaDeHoje,
  LIMITE_DE_ITENS,
  type Avisos,
  type Bloco,
  type ContextoDoInicio,
  type Esperando,
} from "./tipos";
import { HREF_MINHAS_TAREFAS } from "@/lib/tarefas/tipos";

type Db = Awaited<ReturnType<typeof createClient>>;

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

/**
 * O ASSUNTO de cada tipo de aviso, dito como a recepção diria. Os cinco que mais
 * aparecem têm frase própria; os demais usam o rótulo que a Central já mostra
 * (`KIND_LABEL`); `other` e tipo desconhecido não têm assunto e somam em "outros".
 */
export const ROTULO_DO_ASSUNTO: Record<string, string> = {
  case_stale: "Atendimentos parados, esperando decisão",
  promise_unfulfilled: "Equipe prometeu retorno e não voltou",
  appointment_outcome_required: "Consultas sem resultado marcado (veio ou faltou)",
  handoff: "Paciente pediu para falar com uma pessoa",
  followup_dead: "Mensagens de acompanhamento que pararam",
};

function rotuloDoAssunto(kind: string): string | null {
  if (kind === "other") return null;
  return ROTULO_DO_ASSUNTO[kind] ?? (KIND_LABEL as Record<string, string>)[kind] ?? null;
}

/**
 * Avisos por assunto: os `maximo` maiores grupos (empate pela ordem do nome do
 * tipo, para a tela não trocar as linhas de lugar a cada carga) e a soma do
 * resto — os grupos que não couberam e os tipos sem assunto.
 */
export function agruparAvisos(
  kinds: Array<string | null>,
  maximo = 4,
): { grupos: Array<{ kind: string; rotulo: string; total: number }>; outros: number } {
  const porKind = new Map<string, number>();
  for (const k of kinds) porKind.set(k ?? "other", (porKind.get(k ?? "other") ?? 0) + 1);
  const comAssunto = [...porKind.entries()]
    .map(([kind, total]) => ({ kind, rotulo: rotuloDoAssunto(kind), total }))
    .filter((g): g is { kind: string; rotulo: string; total: number } => g.rotulo !== null)
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
  const grupos = comAssunto.slice(0, maximo);
  return { grupos, outros: kinds.length - grupos.reduce((s, g) => s + g.total, 0) };
}

export async function avisosAbertos(db: Db, ctx: ContextoDoInicio): Promise<Avisos> {
  // ponytail: lê até 1000 avisos abertos (teto do PostgREST) e filtra aqui. Numa
  // organização com mais que isso abertos, os mais antigos ficam fora da conta;
  // se acontecer, o conserto é uma função no banco que faça o mesmo filtro.
  const { data, error } = await db
    .from("agent_inbox_items")
    .select("id,kind,ref_kind,ref_id,created_at")
    .eq("organization_id", ctx.orgId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) return { ok: false };
  const linhas = data ?? [];
  const donos = await donosDasReferencias(db, ctx.orgId, linhas);
  const meus = linhas.filter((l) => avisoChegaAQuem(escopoDoAviso(l, donos, ctx.userId), ctx.papel));
  return { ok: true, total: meus.length, ...agruparAvisos(meus.map((l) => l.kind)) };
}

interface EsperandoNoBanco {
  ve_sem_responsavel: boolean;
  recentes: { total: number; com_voce: number; sem_responsavel: number };
  antigas: { total: number; com_voce: number; sem_responsavel: number };
  itens: Array<{
    id: string;
    desde: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
  }>;
}

/**
 * Quem espera resposta de quem está logado: as conversas DELA e as SEM
 * responsável (que qualquer um pode assumir). A contagem é do banco
 * (`fn_inicio_esperando`, migration 0408, SECURITY INVOKER): a RLS de quem lê
 * decide o que entra, então o quadro nunca conta conversa que a pessoa não
 * consegue abrir. Antes eram 200 linhas lidas e filtradas aqui, só das
 * atribuídas — com 788 conversas sem responsável, a tela dizia "ninguém".
 */
export async function esperandoResposta(db: Db, ctx: ContextoDoInicio): Promise<Esperando> {
  const { data, error } = await db.rpc("fn_inicio_esperando", {
    p_org: ctx.orgId,
    p_corte: corteDaEsperaRecente(ctx.agora),
  });
  if (error || !data) return { ok: false };
  const r = data as EsperandoNoBanco;
  return {
    ok: true,
    total: r.recentes.com_voce + r.recentes.sem_responsavel,
    comVoce: r.recentes.com_voce,
    semResponsavel: r.recentes.sem_responsavel,
    veSemResponsavel: r.ve_sem_responsavel,
    antigas: r.antigas.com_voce + r.antigas.sem_responsavel,
    itens: r.itens.map((c) => ({
      id: c.id,
      titulo: rotuloDoContato(c, (texto) => traduzir(texto, ctx.idioma)),
      desde: c.desde,
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
      href: HREF_MINHAS_TAREFAS,
    })),
  };
}
