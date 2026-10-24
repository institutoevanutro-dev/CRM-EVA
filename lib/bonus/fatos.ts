/**
 * O COLETOR do bônus: lê o banco (service role, SEMPRE filtrando a organização
 * de fonte confiável) e entrega ao cálculo puro só dias locais e contagens.
 * O fuso da organização é aplicado AQUI, e em nenhum outro lugar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO } from "@/lib/agenda/fuso";
import { lerPreferencias } from "@/lib/conversoes/preferencias";
import { leadsQueEntraramNoSinal } from "@/lib/conversoes/sinais-do-periodo";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

import type { EntradaDoMes, FatosDaPessoa, TarefaDoMes } from "./calculo";
import { diasDoMes, janelaDoMes, mesDe, somarDias } from "./calendario";
import {
  type DiaDeEnvio,
  historicoDeEnvio,
  type ItemDaFila,
  itensEnviados,
  type MensagemDaEquipe,
  rotinasDaPessoa,
} from "./fila";
import { lerRegras, type RegrasDoBonus } from "./regras";
import { contagemDoDia } from "./stories";
import type { TipoDeItemDaFila } from "./tipos";

export interface ProgramaDoBonus {
  id: string;
  organizationId: string;
  aprovadorUserId: string;
  ativo: boolean;
  regras: RegrasDoBonus;
  fuso: string;
  etapasDeSinalPago: string[];
}

export type LeituraDoPrograma =
  | { status: "ok"; programa: ProgramaDoBonus }
  | { status: "ausente" }
  | { status: "erro"; motivo: string };

const PAGINA = 1000;
const LOTE = 200;
const COLUNAS_DO_PROGRAMA =
  "id, organization_id, aprovador_user_id, ativo, regras, organizations(timezone, settings)";

interface LinhaDoPrograma {
  id: string;
  organization_id: string;
  aprovador_user_id: string;
  ativo: boolean;
  regras: unknown;
  organizations: { timezone: string | null; settings: unknown } | null;
}

function paraPrograma(l: LinhaDoPrograma): LeituraDoPrograma {
  const lidas = lerRegras(l.regras);
  if (!lidas.ok) return { status: "erro", motivo: `regras_invalidas:${lidas.erro}` };
  const tz = l.organizations?.timezone?.trim() ?? "";
  return {
    status: "ok",
    programa: {
      id: l.id,
      organizationId: l.organization_id,
      aprovadorUserId: l.aprovador_user_id,
      ativo: l.ativo,
      regras: lidas.regras,
      fuso: tz !== "" && fusoValido(tz) ? tz : FUSO_PADRAO,
      etapasDeSinalPago: lerPreferencias(l.organizations?.settings).etapasDeSinalPago,
    },
  };
}

export async function lerPrograma(admin: SupabaseClient, organizationId: string): Promise<LeituraDoPrograma> {
  const { data, error } = await admin
    .from("bonus_programas")
    .select(COLUNAS_DO_PROGRAMA)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { status: "erro", motivo: error.message };
  if (!data) return { status: "ausente" };
  return paraPrograma(data as unknown as LinhaDoPrograma);
}

export async function programasAtivos(
  admin: SupabaseClient,
): Promise<{ status: "ok"; programas: ProgramaDoBonus[] } | { status: "erro"; motivo: string }> {
  const { data, error } = await admin.from("bonus_programas").select(COLUNAS_DO_PROGRAMA).eq("ativo", true).limit(100);
  if (error) return { status: "erro", motivo: error.message };
  const programas: ProgramaDoBonus[] = [];
  for (const linha of (data ?? []) as unknown as LinhaDoPrograma[]) {
    const lido = paraPrograma(linha);
    if (lido.status === "ok") programas.push(lido.programa);
  }
  return { status: "ok", programas };
}

async function todas<T>(
  consulta: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const saida: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await consulta(de, de + PAGINA - 1);
    if (error) throw new Error(`bonus_fatos: ${error.message}`);
    saida.push(...(data ?? []));
    if (!data || data.length < PAGINA) return saida;
  }
}

function emLotes<T>(xs: readonly T[]): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < xs.length; i += LOTE) lotes.push(xs.slice(i, i + LOTE));
  return lotes;
}

export interface LinhaDeTarefa {
  id: string;
  status: string;
  due_date: string;
  missed_due_date: string | null;
  closed_at: string | null;
}

export function paraTarefaDoMes(l: LinhaDeTarefa, fuso: string): TarefaDoMes {
  const prazo = l.missed_due_date ?? l.due_date;
  return {
    id: l.id,
    diaDoPrazo: diaLocalISO(new Date(prazo), fuso),
    situacao: l.status === "done" ? "feita" : l.status === "cancelled" ? "cancelada" : "aberta",
    diaDoFechamento: l.closed_at ? diaLocalISO(new Date(l.closed_at), fuso) : null,
    prazoTrocadoAposVencer: l.missed_due_date !== null,
  };
}

interface LinhaDeItem {
  id: string;
  dia: string;
  tipo: TipoDeItemDaFila;
  user_id: string;
  contact_id: string;
  ligacao_registrada_em: string | null;
}

export async function itensDaFila(admin: SupabaseClient, org: string, de: string, ate: string): Promise<ItemDaFila[]> {
  const linhas = await todas<LinhaDeItem>((a, b) =>
    admin
      .from("bonus_fila_itens")
      .select("id, dia, tipo, user_id, contact_id, ligacao_registrada_em")
      .eq("organization_id", org)
      .gte("dia", de)
      .lte("dia", ate)
      .order("id")
      .range(a, b),
  );
  return linhas.map((l) => ({
    id: l.id,
    dia: l.dia,
    tipo: l.tipo,
    userId: l.user_id,
    contactId: l.contact_id,
    ligacaoRegistradaEm: l.ligacao_registrada_em,
  }));
}

export async function mensagensDaEquipe(
  admin: SupabaseClient,
  org: string,
  userIds: readonly string[],
  contactIds: readonly string[],
  inicio: Date,
  fim: Date,
): Promise<MensagemDaEquipe[]> {
  if (userIds.length === 0 || contactIds.length === 0) return [];
  const saida: MensagemDaEquipe[] = [];
  for (const lote of emLotes([...new Set(contactIds)])) {
    const linhas = await todas<{ contact_id: string; sent_by_user_id: string; sent_at: string }>((a, b) =>
      admin
        .from("messages")
        .select("contact_id, sent_by_user_id, sent_at")
        .eq("organization_id", org)
        .eq("direction", "outbound")
        // Enviada PELO CRM por uma pessoa. O celular grava `external_device`.
        .eq("sent_via", "user")
        .neq("status", "failed")
        .in("sent_by_user_id", [...userIds])
        .in("contact_id", lote)
        .gte("sent_at", inicio.toISOString())
        .lt("sent_at", fim.toISOString())
        .order("id")
        .range(a, b),
    );
    for (const l of linhas) saida.push({ contactId: l.contact_id, userId: l.sent_by_user_id, sentAt: l.sent_at });
  }
  return saida;
}

export async function fatosDoMes(
  admin: SupabaseClient,
  programa: ProgramaDoBonus,
  mes: string,
  hoje: string,
): Promise<EntradaDoMes> {
  const org = programa.organizationId;
  const { inicio, fim } = janelaDoMes(mes, programa.fuso);
  const participantes = programa.regras.participantes;
  const primeiro = `${mes}-01`;
  const ultimo = diasDoMes(mes).at(-1)!;

  const [tarefas, itens, stories, comparecimentos, leadsDoSinal] = await Promise.all([
    participantes.length === 0
      ? Promise.resolve([] as (LinhaDeTarefa & { assigned_to: string })[])
      : todas<LinhaDeTarefa & { assigned_to: string }>((a, b) =>
          admin
            .from("crm_tasks")
            .select("id, assigned_to, status, due_date, missed_due_date, closed_at")
            .eq("organization_id", org)
            .in("assigned_to", participantes)
            .or(
              `and(due_date.gte.${inicio.toISOString()},due_date.lt.${fim.toISOString()}),` +
                `and(missed_due_date.gte.${inicio.toISOString()},missed_due_date.lt.${fim.toISOString()})`,
            )
            .order("id")
            .range(a, b),
        ),
    itensDaFila(admin, org, primeiro, ultimo),
    todas<{ dia: string; story_ids: string[]; contagem_manual: number | null }>((a, b) =>
      admin
        .from("bonus_stories_dia")
        .select("dia, story_ids, contagem_manual")
        .eq("organization_id", org)
        .gte("dia", primeiro)
        .lte("dia", ultimo)
        .order("dia")
        .range(a, b),
    ),
    admin
      .from("calendar_appointments")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("status", "completed")
      .is("excluded_at", null)
      .neq("source", "historical_import")
      .gte("starts_at", inicio.toISOString())
      .lt("starts_at", fim.toISOString()),
    leadsQueEntraramNoSinal(admin, org, programa.etapasDeSinalPago, inicio.toISOString(), fim.toISOString()),
  ]);
  if (comparecimentos.error) throw new Error(`bonus_fatos: ${comparecimentos.error.message}`);

  const mensagens = await mensagensDaEquipe(
    admin,
    org,
    participantes,
    itens.filter((i) => i.tipo === "lead_antigo").map((i) => i.contactId),
    inicio,
    fim,
  );
  const enviados = itensEnviados(itens, mensagens, programa.fuso);

  const pessoas: FatosDaPessoa[] = participantes.map((userId) => ({
    userId,
    tarefas: tarefas
      .filter((t) => t.assigned_to === userId)
      .map((t) => paraTarefaDoMes(t, programa.fuso))
      .filter((t) => mesDe(t.diaDoPrazo) === mes),
    ...rotinasDaPessoa(itens, enviados, userId),
    // Etapa 2 (fechamento) preenche: férias e atestado por pessoa.
    diasDeExcecao: [],
  }));

  return {
    mes,
    hoje,
    regras: programa.regras,
    pessoas,
    storiesPorDia: Object.fromEntries(stories.map((s) => [s.dia, contagemDoDia(s)])),
    resultados: {
      comparecimento: comparecimentos.count ?? 0,
      sinal_pago: leadsDoSinal.length,
      // Etapa 2: o aprovador lança no fechamento.
      avaliacao_google: null,
    },
  };
}

/** Os últimos 10 dias corridos antes de hoje: cobre 3 dias úteis seguidos com folga. */
export async function historicoDeEnvioRecente(
  admin: SupabaseClient,
  programa: ProgramaDoBonus,
  hoje: string,
): Promise<DiaDeEnvio[]> {
  const org = programa.organizationId;
  const de = somarDias(hoje, -10);
  const ate = somarDias(hoje, -1);
  const itens = (await itensDaFila(admin, org, de, ate)).filter((i) => i.tipo === "lead_antigo");
  if (itens.length === 0) return [];
  const contatos = [...new Set(itens.map((i) => i.contactId))];
  // Meia-noite UTC do primeiro dia: um pouco antes do início local, de propósito.
  // `itensEnviados` recorta pelo dia local; mensagem a mais não muda o resultado.
  const mensagens = await mensagensDaEquipe(admin, org, programa.regras.participantes, contatos, new Date(`${de}T00:00:00Z`), new Date());
  const bloqueadoEm = new Map<string, string>();
  for (const lote of emLotes(contatos)) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, blocked_at")
      .eq("organization_id", org)
      .in("id", lote)
      .not("blocked_at", "is", null);
    if (error) throw new Error(`bonus_fatos: ${error.message}`);
    for (const c of (data ?? []) as { id: string; blocked_at: string }[]) bloqueadoEm.set(c.id, c.blocked_at);
  }
  return historicoDeEnvio(itens, itensEnviados(itens, mensagens, programa.fuso), bloqueadoEm, programa.fuso);
}
