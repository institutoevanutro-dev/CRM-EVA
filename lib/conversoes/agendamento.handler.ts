/**
 * Avisar a plataforma de anúncio que um paciente AGENDOU — e só isso.
 *
 * ─── O que entra, o que sai ─────────────────────────────────────────────────
 *
 * Escuta `appointment.created` e `appointment.confirmed`, que a rota da Agenda
 * emite por `emit_event` (tela e IA passam pela mesma rota). O payload é DICA e o
 * banco é VERDADE: o handler re-lê o compromisso, o contato e a organização.
 *
 * Do contato saem só o telefone (E.164) e o e-mail, quando houver, que cada
 * transporte normaliza e hasheia, e o identificador do clique, quando houver.
 * O payload do evento traz o nome do tipo de consulta: ele NÃO é lido.
 *
 * ─── Quando não sai nada ────────────────────────────────────────────────────
 *
 *  - o compromisso não está `pending`/`confirmed` (cancelado, excluído, já
 *    aconteceu) ou foi importado (sync do Google, importação de histórico);
 *  - o contato está bloqueado, marcado "sempre atendimento humano", oculto,
 *    anonimizado ou fundido em outro;
 *  - a organização deixou "só quem veio de anúncio" ligado (o padrão) e o
 *    contato não veio de anúncio DAQUELA plataforma;
 *  - a conexão da plataforma não existe, está incompleta ou desligada.
 *
 * Cancelar ou desligar depois NÃO manda nada novo: só encerra o que ainda não
 * saiu. O que já saiu fica como está.
 *
 * ─── Uma vez por agendamento e plataforma ───────────────────────────────────
 *
 * O livro-razão (`ad_conversion_dispatches`) tem índice único por (agendamento,
 * plataforma, evento). `sent` nunca volta. Antes da rede a linha é tomada
 * (`sending`, com a contagem de tentativas como trava otimista), então dois
 * drenos que pegam `created` e `confirmed` do mesmo compromisso não enviam dois.
 * A segunda camada é o `event_id`/`orderId` determinístico, que a plataforma
 * deduplica.
 *
 * ─── Falha ──────────────────────────────────────────────────────────────────
 *
 * Transitória: nova tentativa com espera crescente (1, 2, 4… até 60 min), até
 * `MAX_TENTATIVAS`. O `retry` do `event_log` não conta tentativa, então quem
 * conta é a linha. Permanente, ou tentativas esgotadas: linha `error` com o
 * código curto e UM aviso aberto na Central por organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { idDoEvento, telefoneE164 } from "@/lib/plataformas-de-anuncio/identificadores";
import { ehPlataformaConhecida, enviarConversao, PLATAFORMAS } from "@/lib/plataformas-de-anuncio/registry";
import type {
  ConversaoDeAgendamento,
  NomeDoEvento,
  PlataformaDeAnuncio,
} from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerPreferencias } from "./preferencias";

export const CONSUMER_KEY = "conversoes.agendamento";
const EVENTO: NomeDoEvento = "Schedule";
export const MAX_TENTATIVAS = 8;
/** Linha `sending` mais velha que isto é de um dreno que morreu: pode ser retomada. */
const EM_VOO_MS = 10 * 60 * 1000;
const ESPERA_DE_LEITURA_MS = 5 * 60 * 1000;

/** 1, 2, 4, 8, 16, 32, 60, 60 minutos. */
export function esperaDaTentativa(tentativas: number): number {
  return Math.min(60, 2 ** Math.max(0, tentativas - 1)) * 60_000;
}

const STATUS_DE_AGENDADO = new Set(["pending", "confirmed"]);
const ORIGENS_IMPORTADAS = new Set(["google_sync", "historical_import"]);

interface Compromisso {
  id: string;
  status: string;
  contact_id: string | null;
  created_at: string;
  source: string | null;
  history_import_key: string | null;
  excluded_at: string | null;
}

interface Contato {
  phone_number: string | null;
  email: string | null;
  is_blocked: boolean | null;
  ai_opt_out: boolean | null;
  is_anonymized: boolean | null;
  is_merged_into: string | null;
  inbox_hidden_at: string | null;
  source_metadata: unknown;
}

interface LinhaDoLivro {
  id: string;
  platform: string;
  status: string;
  attempts: number;
  attempted_at: string;
  next_attempt_at: string | null;
}

/** Por que um contato nunca vai. A ordem é só a do texto; qualquer um basta. */
export function motivoDeExclusao(c: Contato): string | null {
  if (c.is_anonymized) return "contato_anonimizado";
  if (c.is_merged_into) return "contato_fundido";
  if (c.is_blocked) return "contato_bloqueado";
  if (c.ai_opt_out) return "sempre_atendimento_humano";
  if (c.inbox_hidden_at) return "contato_oculto";
  return null;
}

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const objeto = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * De onde o contato veio, e os cliques — lidos do registro de primeiro toque
 * (0164). O clique da Meta vem do payload CRU (`ad_raw`), nunca de
 * `ad_source_id`: os dois extratores gravam ali o id do ANÚNCIO quando não há
 * clique, e mandá-lo como `ctwa_clid` seria afirmar um clique que não existiu.
 */
export function lerOrigem(sourceMetadata: unknown): {
  plataforma: PlataformaDeAnuncio | null;
  cliqueMeta: string | null;
  cliqueGoogle: string | null;
} {
  const meta = objeto(sourceMetadata);
  const bruto = objeto(meta.ad_raw);
  const plataforma = ehPlataformaConhecida(meta.ad_platform) ? meta.ad_platform : null;
  return {
    plataforma,
    cliqueMeta: plataforma === "meta_ads" ? (texto(bruto.ctwa_clid) ?? texto(bruto.ctwaClid)) : null,
    cliqueGoogle: texto(meta.gclid) ?? texto(bruto.gclid),
  };
}

const resultado = (status: HandlerResult["status"], detail?: string, retryAt?: number): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
  ...(retryAt !== undefined ? { retry_at: new Date(retryAt).toISOString() } : {}),
});

/** Encerra sem envio o que ainda não saiu. `sent` e `error` ficam como estão. */
async function encerrar(
  admin: SupabaseClient,
  organizationId: string,
  linhas: LinhaDoLivro[],
  motivo: string,
): Promise<void> {
  const abertas = linhas.filter((l) => l.status === "pending" || l.status === "sending").map((l) => l.id);
  if (!abertas.length) return;
  const { error } = await admin
    .from("ad_conversion_dispatches")
    .update({ status: "skipped", reason: motivo, next_attempt_at: null })
    .eq("organization_id", organizationId)
    .in("id", abertas);
  if (error) logger.error("[conversoes.agendamento] não encerrei pendentes", { motivo, error: error.message });
}

async function abrirAviso(admin: SupabaseClient, organizationId: string, plataforma: PlataformaDeAnuncio, codigo: string) {
  const nome = plataforma === "meta_ads" ? "Meta" : "Google Ads";
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: "ad_conversion_failing",
    severity: "warn",
    title: `O aviso de agendamento para o ${nome} não está saindo`,
    body:
      `A plataforma recusou ou não respondeu depois de várias tentativas (código ${codigo}). ` +
      "Confira a conexão em Configurações › Conversões. Nenhum dado do paciente aparece neste aviso.",
  });
  // 23505: já há um aberto para a organização (índice parcial da 0391).
  if (error && error.code !== "23505") {
    logger.error("[conversoes.agendamento] aviso na Central falhou", { organizationId, error: error.message });
  }
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return resultado("skipped", "sem_entidade");
  const admin = createAdminClient();
  const org = row.organization_id;
  const agora = Date.now();

  // ⚠️ Organização junto do id em toda leitura: o client é service-role.
  const { data: dataCompromisso, error: erroCompromisso } = await admin
    .from("calendar_appointments")
    .select("id, status, contact_id, created_at, source, history_import_key, excluded_at")
    .eq("id", row.entity_id)
    .eq("organization_id", org)
    .maybeSingle();
  if (erroCompromisso) return resultado("retry", "leitura_do_compromisso", agora + ESPERA_DE_LEITURA_MS);
  if (!dataCompromisso) return resultado("skipped", "compromisso_inexistente");
  const compromisso = dataCompromisso as Compromisso;

  const { data: dataLivro, error: erroLivro } = await admin
    .from("ad_conversion_dispatches")
    .select("id, platform, status, attempts, attempted_at, next_attempt_at")
    .eq("organization_id", org)
    .eq("appointment_id", compromisso.id)
    .eq("event_name", EVENTO);
  if (erroLivro) return resultado("retry", "leitura_do_livro", agora + ESPERA_DE_LEITURA_MS);
  const livro = (dataLivro ?? []) as LinhaDoLivro[];

  if (!STATUS_DE_AGENDADO.has(compromisso.status) || compromisso.excluded_at) {
    await encerrar(admin, org, livro, "agendamento_cancelado");
    return resultado("skipped", "nao_esta_agendado");
  }
  if (ORIGENS_IMPORTADAS.has(compromisso.source ?? "") || compromisso.history_import_key) {
    return resultado("skipped", "importado");
  }
  if (!compromisso.contact_id) return resultado("skipped", "sem_contato");

  const [{ data: dataOrg }, { data: dataContato, error: erroContato }] = await Promise.all([
    admin.from("organizations").select("settings").eq("id", org).maybeSingle(),
    admin
      .from("contacts")
      .select(
        "phone_number, email, is_blocked, ai_opt_out, is_anonymized, is_merged_into, inbox_hidden_at, source_metadata",
      )
      .eq("id", compromisso.contact_id)
      .eq("organization_id", org)
      .maybeSingle(),
  ]);
  if (erroContato) return resultado("retry", "leitura_do_contato", agora + ESPERA_DE_LEITURA_MS);
  if (!dataContato) return resultado("skipped", "sem_contato");
  const contato = dataContato as Contato;

  const exclusao = motivoDeExclusao(contato);
  if (exclusao) {
    await encerrar(admin, org, livro, exclusao);
    return resultado("skipped", exclusao);
  }

  const telefone = telefoneE164(contato.phone_number);
  const email = texto(contato.email);
  if (!telefone && !email) return resultado("skipped", "sem_identificador");

  const { somenteDeAnuncio } = lerPreferencias((dataOrg as { settings?: unknown } | null)?.settings);
  const origem = lerOrigem(contato.source_metadata);

  const conversao: ConversaoDeAgendamento = {
    organizationId: org,
    agendamentoId: compromisso.id,
    evento: EVENTO,
    eventoId: idDoEvento(org, compromisso.id, EVENTO),
    ocorridoEm: new Date(compromisso.created_at),
    telefone,
    email,
    cliqueMeta: origem.cliqueMeta,
    cliqueGoogle: origem.cliqueGoogle,
  };

  let proxima: number | null = null;
  const reagendar = (quando: number) => {
    proxima = proxima === null ? quando : Math.min(proxima, quando);
  };
  const detalhes: string[] = [];

  for (const plataforma of PLATAFORMAS) {
    const linha = livro.find((l) => l.platform === plataforma);
    if (linha?.status === "sent" || linha?.status === "error") continue;

    if (somenteDeAnuncio && origem.plataforma !== plataforma) {
      if (linha) await encerrar(admin, org, [linha], "fora_da_origem");
      detalhes.push(`${plataforma}:fora_da_origem`);
      continue;
    }

    const credencial = await lerCredencial(admin, org, plataforma);
    if (!credencial.ok) {
      if (linha) await encerrar(admin, org, [linha], credencial.motivo);
      detalhes.push(`${plataforma}:${credencial.motivo}`);
      continue;
    }

    if (linha?.status === "sending" && agora - Date.parse(linha.attempted_at) < EM_VOO_MS) {
      reagendar(Date.parse(linha.attempted_at) + EM_VOO_MS);
      continue;
    }
    if (linha?.next_attempt_at && Date.parse(linha.next_attempt_at) > agora) {
      reagendar(Date.parse(linha.next_attempt_at));
      continue;
    }

    // Tomar a linha ANTES da rede. Quem perde a corrida volta em 1 minuto e
    // encontra `sent` ou `sending`.
    const tomadaEm = new Date(agora).toISOString();
    let id: string | null = null;
    if (!linha) {
      const { data, error } = await admin
        .from("ad_conversion_dispatches")
        .insert({
          organization_id: org,
          appointment_id: compromisso.id,
          platform: plataforma,
          event_name: EVENTO,
          event_id: conversao.eventoId,
          status: "sending",
          attempts: 0,
          attempted_at: tomadaEm,
        })
        .select("id")
        .maybeSingle();
      if (error) {
        reagendar(agora + 60_000);
        continue;
      }
      id = (data as { id: string } | null)?.id ?? null;
    } else {
      const { data } = await admin
        .from("ad_conversion_dispatches")
        .update({ status: "sending", attempted_at: tomadaEm })
        .eq("organization_id", org)
        .eq("id", linha.id)
        .eq("status", linha.status)
        .eq("attempts", linha.attempts)
        .select("id");
      id = (data as { id: string }[] | null)?.[0]?.id ?? null;
    }
    if (!id) {
      reagendar(agora + 60_000);
      continue;
    }

    const tentativas = (linha?.attempts ?? 0) + 1;
    const r = await enviarConversao(credencial.credencial, conversao);

    if (r.tipo === "ok") {
      await admin
        .from("ad_conversion_dispatches")
        .update({
          status: "sent",
          attempts: tentativas,
          sent_at: new Date().toISOString(),
          reason: null,
          error_code: null,
          next_attempt_at: null,
        })
        .eq("organization_id", org)
        .eq("organization_id", org)
      .eq("id", id);
      detalhes.push(`${plataforma}:enviado`);
      continue;
    }

    if (r.tipo === "transitorio" && tentativas < MAX_TENTATIVAS) {
      const quando = Date.now() + esperaDaTentativa(tentativas);
      await admin
        .from("ad_conversion_dispatches")
        .update({
          status: "pending",
          attempts: tentativas,
          reason: "tentando_de_novo",
          error_code: r.codigo,
          next_attempt_at: new Date(quando).toISOString(),
        })
        .eq("organization_id", org)
        .eq("organization_id", org)
      .eq("id", id);
      reagendar(quando);
      continue;
    }

    await admin
      .from("ad_conversion_dispatches")
      .update({
        status: "error",
        attempts: tentativas,
        reason: r.tipo === "permanente" ? "recusado_pela_plataforma" : "sem_resposta",
        error_code: r.codigo,
        next_attempt_at: null,
      })
      .eq("organization_id", org)
      .eq("id", id);
    await abrirAviso(admin, org, plataforma, r.codigo);
    detalhes.push(`${plataforma}:erro`);
  }

  if (proxima !== null) return resultado("retry", "aguardando_nova_tentativa", proxima);
  return resultado("ok", detalhes.join(",") || "nada_a_enviar");
}

export const conversaoDeAgendamentoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["appointment.created", "appointment.confirmed"],
  handle,
};
