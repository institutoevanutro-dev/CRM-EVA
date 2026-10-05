/**
 * LGPD export collector — aggregates all personal data the CRM holds about
 * one contact (Art. 18 II — direito de acesso).
 *
 * CLAUDE.md §LGPD: every query filters `organization_id` programmatically
 * (admin client bypasses RLS). PII is NEVER logged — only ids and counts.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { Json } from "@/lib/database.types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContactSnapshot {
  id: string;
  name: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  cpf_present: boolean;
  birthdate: string | null;
  is_blocked: boolean;
  is_anonymized: boolean;
  consent: Record<string, unknown> | null;
  tags: string[];
  source: string | null;
  source_metadata: Record<string, unknown> | null;
  created_at: string;
  last_activity_at: string | null;
  /** Primeiro atendimento marcado. Sobrevive à anonimização: é registro de operação. */
  first_service_at: string | null;
}

export interface ConsentRow {
  scope: string;
  granted: boolean;
  granted_at: string | null;
  source?: string | null;
}

export interface ConversationRow {
  id: string;
  status: string;
  channel: string;
  last_inbound_at: string | null;
  last_message_at: string | null;
  is_group: boolean;
  created_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: string;
  type: string;
  status: string;
  body: string | null;
  has_media: boolean;
  /**
   * Transcrição do áudio / texto extraído da mídia (OCR) que a IA leu
   * (migration 0058). O binário nunca vai no pacote (só `has_media`); sem esta
   * coluna o export não trazia nem o texto que a IA efetivamente processou.
   */
  media_derived_text: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface LeadRow {
  id: string;
  pipeline_id: string;
  stage_id: string;
  title: string | null;
  status: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
}

export interface OrderRow {
  id: string;
  external_id: string | null;
  external_provider: string | null;
  status: string;
  total_cents: number | null;
  currency: string | null;
  ordered_at: string | null;
}

export interface ActivityRow {
  id: string;
  lead_id: string | null;
  type: string;
  source_module: string | null;
  performed_at: string;
}

/**
 * O resumo que o agente guarda sobre o titular (`lead_checkpoints`).
 *
 * Entra porque a anonimização o REDIGE (migration 0308): o resumo corrido, os
 * compromissos e a próxima ação são texto que o modelo escreveu SOBRE a pessoa,
 * e o que se apaga a pedido do titular é o que se entrega a pedido dele.
 * Portado do DeskcommCRM PR 1501 (@melgarafael).
 */
export interface CheckpointRow {
  id: string;
  rolling_summary: string;
  commitments: unknown;
  objections: unknown;
  next_action: string | null;
  created_at: string;
}

/**
 * Compromisso da agenda do titular.
 *
 * As colunas são as MESMAS que a migration 0184 redige ao anonimizar — e não é
 * coincidência: o que se apaga a pedido do titular é exatamente o que se
 * entrega a pedido dele. `starts_at`/`ends_at`/`status` a 0184 PRESERVA (é
 * registro de operação da clínica), e ainda assim entram aqui: o Art. 18 II é
 * sobre o que a organização sabe A RESPEITO DELE, e "houve consulta em tal dia"
 * é a informação mais legível que este export carrega.
 */
export interface AppointmentRow {
  id: string;
  title: string | null;
  description: string | null;
  notes: string | null;
  location_details: string | null;
  cancellation_reason: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: string;
  google_base_projection?: Json | null;
  google_conflict?: Json | null;
  google_pending_write?: Json | null;
  meeting_url?: string | null;
  meeting_state?: string;
}

/**
 * Tarefa combinada SOBRE a pessoa (migration 0210).
 *
 * ⚠️ ESTE BLOCO NASCEU COM A OUTRA METADE, e não depois dela. A migration liga o
 * trigger `trg_redigir_tarefas_ao_anonimizar`, que troca `title` e apaga
 * `description` quando o titular pede apagamento — e neste repo redigir e
 * exportar sempre andam juntos: o que se apaga a pedido do titular é o que se
 * entrega a pedido dele. Foi assim que `calendar_appointments` e
 * `webhook_lead_captures` chegaram aqui, as duas depois do fato, achadas por
 * `tests/unit/lgpd-exporta-o-que-redige.test.ts`.
 *
 * `due_date`, `status` e `priority` vão junto porque o titular tem direito a
 * saber não só que a empresa escreveu algo sobre ele, mas quando ela combinou
 * agir — que é a informação que dá sentido ao texto.
 */
export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  status: string;
  priority: string;
}

/**
 * Captação por webhook — de onde a pessoa veio.
 *
 * ⚠️ ESTA NÃO É DA ENTREGA DO CALENDÁRIO. Ela apareceu porque o gate novo
 * (`tests/unit/lgpd-exporta-o-que-redige.test.ts`) DERIVA a lista das duas
 * pontas em vez de escrevê-la: a mesma classe de defeito tinha duas instâncias,
 * e a segunda ninguém sabia que existia. Uma allowlist fixa teria fechado só a
 * que eu já conhecia.
 *
 * As colunas são exatamente as que `fn_redigir_captacoes_do_contato_anonimizado`
 * zera — inclusive `remote_ip` e `user_agent`, que a LGPD trata como dado
 * pessoal e que a organização guarda a respeito do titular.
 */
export interface CaptureRow {
  id: string;
  source_name: string | null;
  outcome: string;
  captured_name: string | null;
  captured_phone: string | null;
  captured_email: string | null;
  fields: unknown;
  utm: unknown;
  remote_ip: string | null;
  user_agent: string | null;
  received_at: string;
}

/**
 * Identidade do titular num canal externo (migration 0277 — Instagram; a
 * coluna `channel` é o que distingue quando um segundo canal chegar).
 *
 * `handle`/`display_name`/`avatar_url` são exatamente o que o passo 7c de
 * `fn_lgpd_cascade_redact_contact` redige ao anonimizar — o que se apaga a
 * pedido do titular é o que se entrega a pedido dele. `external_id` entra
 * porque é o identificador da conta dele NO CANAL (o IGSID), não um ponteiro
 * interno nosso.
 */
export interface ChannelIdentityRow {
  id: string;
  channel: string;
  external_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

/**
 * Um comentário que o titular fez num post da organização no Instagram
 * (migration 0280).
 *
 * Entra porque a anonimização o REDIGE (passo 7c-1 da cascata, migration
 * 0317): texto, @, sugestão de resposta e motivo. O que se apaga a pedido do
 * titular é o que se entrega a pedido dele. O IGSID não se repete aqui — já
 * está em `channel_identities`.
 */
export interface InstagramCommentRow {
  id: string;
  media_id: string;
  texto: string | null;
  autor_handle: string | null;
  comentado_em: string;
  situacao: string;
  sugestao_de_resposta: string | null;
  motivo_do_toque: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
}

/** Entrega do link: estado e referência ao compromisso, sem autorização/claim. */
export interface MeetingDeliveryRow {
  id: string;
  status: string;
  created_at: string;
  run_after: string;
  appointment_id: string | null;
}

/** Aviso sobre um compromisso comprovadamente ligado ao titular. */
export interface AppointmentNoticeRow {
  id: string;
  ref_id: string | null;
  title: string;
  body: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Um caso aberto pela IA sobre o titular — o que ela entendeu quando travou.
 *
 * O vínculo é pela CONVERSA: `agent_cases` não tem FK para `contacts`. O
 * `context_snapshot` fica fora: é o recorte da conversa que foi ao modelo, e
 * as mensagens dele já saem no bloco próprio.
 */
export interface CaseRow {
  id: string;
  conversation_id: string;
  status: string;
  title: string;
  summary: string;
  blocker: string;
  source: string;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
}

/** Uma linha do tempo do caso: quem tocou, quando, e o que escreveu. */
export interface CaseEventRow {
  id: string;
  case_id: string;
  kind: string;
  actor_kind: string;
  human_action: string | null;
  body: string | null;
  metadata: unknown;
  created_at: string;
}

/** Uma demanda do titular — o pedido, o próximo passo e o desfecho. */
export interface DemandaRow {
  id: string;
  agent_case_id: string | null;
  origem: string;
  assunto: string | null;
  estado: string;
  dono_kind: string;
  proximo_passo: string | null;
  desfecho: string | null;
  aberta_em: string;
  fechada_em: string | null;
}

/**
 * Um aviso da Central que aponta para o titular, uma conversa dele ou um caso
 * dele. O título e o corpo podem citar o telefone, o resumo da conversa ou o
 * título do caso — é o que o passo 7g da cascata apaga.
 */
export interface CentralNoticeRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/** Uma chamada de voz do titular — o registro, não a gravação (não gravamos). */
export interface VoiceCallRow {
  id: string;
  direction: string;
  peer_phone: string;
  status: string;
  end_reason: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

/**
 * Uma campanha que falou com este titular (migration 0374).
 *
 * O texto vai junto porque é o que foi DITO a ele; o telefone não, porque ele já
 * está no bloco do contato e repeti-lo só multiplica PII no arquivo entregue.
 */
export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  status: string;
  eligibility_status: string;
  exclusion_reason: string | null;
  rendered_body: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  opted_out_at: string | null;
}

/**
 * Uma linha da lista de exclusão de campanhas que aponta para este titular
 * (migration 0375).
 *
 * O hash do telefone NÃO entra: ele não diz nada a quem lê e não é dado que o
 * titular reconheça. O que entra é o fato — "este número está fora das
 * campanhas desde tal dia, por tal motivo" —, que é exatamente a informação
 * dele que a organização guarda.
 */
export interface CampaignSuppressionRow {
  id: string;
  address_tail: string | null;
  reason: string | null;
  source: string;
  created_at: string;
}

export interface ExportPayload {
  request_id: string;
  organization_id: string;
  /**
   * Razão social do CONTROLADOR (`organizations.legal_name`, `NOT NULL` em
   * `supabase/baseline.sql:1749`). É o que o rodapé do relatório imprime — e é
   * de propósito que NÃO é a marca: ver `lib/lgpd/pdf-renderer.tsx`.
   */
  organization_legal_name: string;
  /** Nome fantasia. Não vai para o rodapé; existe para o JSON do export. */
  organization_display_name: string;
  /** Encarregado da organização. `null` cai em `env.LGPD_DPO_EMAIL`. */
  dpo_email: string | null;
  generated_at: string;
  no_local_footprint: boolean;
  contact: ContactSnapshot | null;
  consents: ConsentRow[];
  conversations: ConversationRow[];
  messages_count_total: number;
  messages_recent: MessageRow[];
  leads: LeadRow[];
  orders: OrderRow[];
  activities: ActivityRow[];
  /** Opcional: o JSON leva; o PDF não o lê. */
  checkpoints?: CheckpointRow[];
  appointments: AppointmentRow[];
  tasks: TaskRow[];
  webhook_captures: CaptureRow[];
  audit_log_extract: AuditRow[];
  meeting_deliveries: MeetingDeliveryRow[];
  appointment_notices: AppointmentNoticeRow[];
  /**
   * Chamadas de voz (migration 0232).
   *
   * Entra porque a anonimização APAGA: a 0235 pôs `voice_calls` na cascata de
   * redação, e o que se apaga a pedido do titular é o que se entrega a pedido
   * dele. Sem este bloco o relatório dizia "houve uma atividade de chamada" na
   * linha do tempo e não mostrava chamada nenhuma — export incoerente com o
   * próprio cascade.
   */
  voice_calls: VoiceCallRow[];
  channel_identities: ChannelIdentityRow[];
  /** Comentários do titular em posts da organização. Opcional como `reply_drafts`. */
  instagram_comments?: InstagramCommentRow[];
  /**
   * Casos, linha do tempo do caso, demandas e avisos da Central (migration 0317).
   *
   * Entram porque a 0317 os pôs na cascata de anonimização, e o que se apaga a
   * pedido do titular é o que se entrega a pedido dele. Sem estes blocos o
   * relatório mostrava a conversa e não mencionava que o atendimento tinha
   * parado, o que a IA entendeu do problema, nem o que a equipe anotou — a
   * parte em que uma pessoa identificável é DESCRITA por máquina. Opcionais
   * como `reply_drafts`.
   */
  cases?: CaseRow[];
  case_events?: CaseEventRow[];
  demandas?: DemandaRow[];
  avisos_da_central?: CentralNoticeRow[];
  /**
   * Campanhas que falaram com o titular (migration 0343).
   *
   * Entra pelo mesmo motivo de `voice_calls`: o trigger
   * `trg_redigir_campanhas_anonimizado` APAGA o texto e o telefone destas linhas
   * quando ele pede anonimização, e o que se apaga a pedido dele é o que se
   * entrega a pedido dele (Art. 18 II). Sem este bloco, alguém que recebeu uma
   * prospecção pediria acesso e não veria a mensagem que recebeu.
   */
  campaign_recipients: CampaignRecipientRow[];
  /**
   * Lista de exclusão de campanhas (migration 0375).
   *
   * Entra pelo mesmo motivo das demais: o trigger
   * `trg_redigir_exclusoes_anonimizado` APAGA o vínculo e os últimos dígitos
   * quando o titular pede anonimização, e o que se apaga a pedido dele é o que
   * se entrega a pedido dele (Art. 18 II).
   */
  campaign_suppressions: CampaignSuppressionRow[];
  reply_drafts?: Array<{
    id: string;
    status: string;
    original_body: string | null;
    edited_body: string | null;
    approved_body: string | null;
    proposals: unknown;
    feedback: unknown;
    created_at: string;
  }>;
  /**
   * Notas internas das conversas do titular — o texto que a equipe escreveu
   * SOBRE ele e a mídia anexada junto. A cascata de anonimização redige esta
   * tabela (migration 0303), e o que se apaga a pedido dele é o que se entrega
   * a pedido dele (Art. 18 II). A mídia vem como METADADO: nenhum binário
   * trafega pelo export.
   */
  conversation_notes?: Array<{
    id: string;
    conversation_id: string;
    body: string;
    media_storage_path: string | null;
    media_mime: string | null;
    media_size_bytes: number | null;
    created_at: string;
    created_by_name: string | null;
  }>;
  /**
   * Memória da IA sobre o titular: `lead_notes` guarda `headline` + `body` — o
   * nome e trechos do que a pessoa escreveu. Art. 18 II: quem pede os próprios
   * dados recebe também o que a IA anotou sobre ele. Escopo: org + contato.
   */
  lead_notes?: Array<{
    id: string;
    headline: string | null;
    body: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>;
  /**
   * Registro de execução da IA: de `ai_agent_runs.tool_calls` (jsonb) saem só o
   * nome e os argumentos de cada ferramenta. O `result` e o texto do passo
   * ficam de fora — podem trazer dado de OUTROS contatos (ver
   * `toolCallsParaOTitular`). Escopo: org + contato.
   */
  ai_agent_runs?: Array<{
    id: string;
    tool_calls: unknown;
    created_at: string | null;
  }>;
  /**
   * Estado da lead: `lead_state.next_action` (texto) e `qualification` (jsonb)
   * descrevem o titular por máquina. Escopo: org + contato.
   */
  lead_state?: Array<{
    id: string;
    next_action: string | null;
    qualification: unknown;
    updated_at: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// collectExportData
// ---------------------------------------------------------------------------

interface CollectArgs {
  organizationId: string;
  requestId: string;
  contactId: string | null;
  externalCustomerId: string | null;
}

const RECENT_MESSAGES_LIMIT = 100;
const AUDIT_LIMIT = 200;

/** A identidade JURÍDICA da organização — quem responde pelos dados. */
interface Controlador {
  legal_name: string;
  display_name: string;
  dpo_email: string | null;
}

/**
 * Lê o controlador. NUNCA lança e nunca inventa: se a leitura falhar, os campos
 * saem vazios e o rodapé mostra o traço de campo ausente. Abortar o export
 * seria trocar um rodapé feio por um SLA legal de D+7 estourado; preencher com
 * o nome do produto seria escrever a entidade errada num documento jurídico.
 */
async function lerControlador(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  requestId: string,
): Promise<Controlador> {
  const vazio: Controlador = { legal_name: "", display_name: "", dpo_email: null };
  const { data, error } = await admin
    .from("organizations")
    .select("legal_name, display_name, dpo_email")
    .eq("id", organizationId)
    .maybeSingle();
  if (error || !data) {
    logger.warn("[lgpd-export-worker] organization load failed", {
      request_id: requestId,
      error: error?.message ?? "not_found",
    });
    return vazio;
  }
  return {
    legal_name: data.legal_name ?? "",
    display_name: data.display_name ?? "",
    dpo_email: data.dpo_email ?? null,
  };
}

/**
 * O que o titular recebe de `ai_agent_runs.tool_calls`: por passo, o nome e os
 * argumentos de cada ferramenta — o que o agente fez com o que a pessoa
 * escreveu. Saem o `result` de cada chamada e o `text` do passo (forma em
 * `lib/ai/runtime/serialize.ts`): o `result` de `crm_search_contacts` traz
 * nome, telefone e e-mail de OUTROS contatos — entregá-lo seria dar ao titular
 * A o dado do titular B. O texto do modelo pode repetir esse resultado.
 * Passo já redigido (`redacted: true`, sem `args`) sai como está.
 */
export function toolCallsParaOTitular(toolCalls: unknown): unknown[] {
  const passos = Array.isArray(toolCalls) ? (toolCalls as unknown[]) : [];
  return passos.map((p) => {
    const passo = (p ?? {}) as {
      step?: unknown;
      tool_name?: unknown;
      redacted?: unknown;
      tool_calls?: unknown;
    };
    const chamadas = Array.isArray(passo.tool_calls) ? (passo.tool_calls as unknown[]) : [];
    return {
      ...(passo.step !== undefined ? { step: passo.step } : {}),
      ...(typeof passo.tool_name === "string" ? { tool_name: passo.tool_name } : {}),
      ...(passo.redacted === true ? { redacted: true } : {}),
      tool_calls: chamadas.map((c) => {
        const chamada = (c ?? {}) as { tool_name?: unknown; args?: unknown };
        return {
          tool_name: typeof chamada.tool_name === "string" ? chamada.tool_name : "unknown",
          ...(chamada.args !== undefined ? { args: chamada.args } : {}),
        };
      }),
    };
  });
}

export async function collectExportData(args: CollectArgs): Promise<ExportPayload> {
  const admin = createAdminClient();
  const { organizationId, requestId, externalCustomerId } = args;
  // ANTES do primeiro `return`: o caminho "nenhum dado localizado" também gera
  // um relatório entregue ao titular, e ele precisa nomear o controlador igual.
  const controlador = await lerControlador(admin, organizationId, requestId);
  let contactId = args.contactId;

  // Resolve contact_id when only external customer id is provided.
  if (!contactId && externalCustomerId) {
    const { data, error } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("source", "nuvemshop")
      .eq("source_metadata->>nuvemshop_customer_id", externalCustomerId)
      .maybeSingle();
    if (error) {
      logger.warn("[lgpd-export-worker] resolve-by-external failed", {
        request_id: requestId,
        error: error.message,
      });
    }
    if (data) contactId = data.id;
  }

  // No contact AND no external customer -> empty footprint.
  if (!contactId && !externalCustomerId) {
    return emptyPayload(requestId, organizationId, controlador);
  }

  // Contact snapshot (PII intentionally retained — this report is the data
  // owner's right of access; only logs/metadata stay sanitized).
  let contact: ContactSnapshot | null = null;
  if (contactId) {
    const { data, error } = await admin
      .from("contacts")
      .select(
        "id, name, display_name, email, phone_number, cpf_encrypted, birthdate, is_blocked, is_anonymized, consent, tags, source, source_metadata, custom_fields, created_at, last_activity_at, first_service_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) {
      logger.warn("[lgpd-export-worker] contact load failed", {
        request_id: requestId,
        error: error.message,
      });
    }
    if (data) {
      contact = {
        id: data.id,
        name: data.name ?? null,
        display_name: data.display_name ?? null,
        email: data.email ?? null,
        phone_number: data.phone_number ?? null,
        cpf_present: Boolean(data.cpf_encrypted),
        birthdate: data.birthdate ?? null,
        is_blocked: Boolean(data.is_blocked),
        is_anonymized: Boolean(data.is_anonymized),
        consent: (data.consent as Record<string, unknown> | null) ?? null,
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        source: data.source ?? null,
        source_metadata: (data.source_metadata as Record<string, unknown> | null) ?? null,
        created_at: data.created_at,
        last_activity_at: data.last_activity_at ?? null,
        first_service_at: data.first_service_at ?? null,
      };
    }
  }

  // No `consents` table in current schema; legal basis is in contacts.consent JSONB.
  const consents: ConsentRow[] = [];
  if (contact?.consent && typeof contact.consent === "object") {
    for (const [scope, value] of Object.entries(contact.consent)) {
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        consents.push({
          scope,
          granted: Boolean(v.granted),
          granted_at: typeof v.granted_at === "string" ? v.granted_at : null,
          source: typeof v.source === "string" ? v.source : null,
        });
      } else {
        consents.push({
          scope,
          granted: Boolean(value),
          granted_at: null,
        });
      }
    }
  }

  // Conversations.
  let conversations: ConversationRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("conversations")
      .select("id, status, channel, last_inbound_at, last_message_at, is_group, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] conversations load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      conversations = data.map((c) => ({
        id: c.id,
        status: c.status,
        channel: c.channel,
        last_inbound_at: c.last_inbound_at,
        last_message_at: c.last_message_at,
        is_group: Boolean(c.is_group),
        created_at: c.created_at,
      }));
    }
  }

  // Messages — count total + sample recent.
  let messages_count_total = 0;
  let messages_recent: MessageRow[] = [];
  if (contactId) {
    const { count, error: countErr } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId);
    if (countErr) {
      logger.warn("[lgpd-export-worker] messages count failed", {
        request_id: requestId,
        error: countErr.message,
      });
    } else {
      messages_count_total = count ?? 0;
    }

    const { data, error } = await admin
      .from("messages")
      .select("id, conversation_id, direction, type, status, body, media_url, media_derived_text, sent_at, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(RECENT_MESSAGES_LIMIT);
    if (error) {
      logger.warn("[lgpd-export-worker] messages recent load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      messages_recent = data.map((m) => ({
        id: m.id,
        conversation_id: m.conversation_id,
        direction: m.direction,
        type: m.type,
        status: m.status,
        body: m.body,
        has_media: Boolean(m.media_url),
        media_derived_text: m.media_derived_text ?? null,
        sent_at: m.sent_at,
        created_at: m.created_at,
      }));
    }
  }

  // Leads (direct contact_id FK on crm_leads).
  let leads: LeadRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, pipeline_id, stage_id, title, status, value_cents, currency, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      logger.warn("[lgpd-export-worker] leads load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      leads = data;
    }
  }

  // Orders (contact_id when available, otherwise external_customer_id).
  let orders: OrderRow[] = [];
  {
    let q = admin
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, ordered_at, contact_id, customer_external_id",
      )
      .eq("organization_id", organizationId)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(500);
    if (contactId) {
      q = q.eq("contact_id", contactId);
    } else if (externalCustomerId) {
      q = q.eq("customer_external_id", externalCustomerId);
    }
    const { data, error } = await q;
    if (error) {
      logger.warn("[lgpd-export-worker] orders load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      orders = data.map((o) => ({
        id: o.id,
        external_id: o.external_id,
        external_provider: o.external_provider,
        status: o.status,
        total_cents: o.total_cents,
        currency: o.currency,
        ordered_at: o.ordered_at,
      }));
    }
  }

  // Activities — direct contact_id on crm_lead_activities.
  let activities: ActivityRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_lead_activities")
      .select("id, lead_id, type, source_module, performed_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("performed_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] activities load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      activities = data;
    }
  }

  // Resumos do agente — contact_id direto em lead_checkpoints.
  let checkpoints: CheckpointRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("lead_checkpoints")
      .select("id, rolling_summary, commitments, objections, next_action, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] checkpoints load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      checkpoints = data;
    }
  }

  // Agenda — contact_id direto em calendar_appointments.
  //
  // ⚠️ ESTA METADE FALTAVA, e a outra tinha gate. A migration 0184 declarou esta
  // tabela dado pessoal e ligou o trigger de REDAÇÃO; esta branch escreveu
  // `tests/invariants/agenda-lgpd-alcanca.test.ts` com quatro casos para provar
  // a redação — e ninguém acrescentou a agenda ao EXPORT. O titular exercia o
  // Art. 18 II e recebia um relatório que não mencionava nenhuma consulta que
  // ele marcou. Neste repo, redigir e exportar sempre andaram juntos.
  let appointments: AppointmentRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("calendar_appointments")
      .select(
        "id, title, description, notes, location_details, cancellation_reason, starts_at, ends_at, time_zone, status, google_base_projection, google_conflict, google_pending_write, meeting_url, meeting_state",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("starts_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] appointments load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      appointments = data;
    }
  }

  // Tarefas — contact_id direto em crm_tasks (migration 0210).
  //
  // O texto que a equipe escreveu sobre o titular ("ligar para Fulano confirmar
  // o orçamento") é dado dele. Se a anonimização o apaga — e ela apaga —, o
  // pedido de acesso tem de entregá-lo.
  let tasks: TaskRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("crm_tasks")
      .select("id, title, description, due_date, status, priority")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("due_date", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] tasks load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      tasks = data;
    }
  }

  // Chamadas de voz — `contact_id` direto em `voice_calls` (migration 0232).
  //
  // O que existe aqui é o REGISTRO da ligação, nunca o áudio: gravação está
  // deliberadamente fora do produto (spec 18 §1.2), então não há mídia a
  // enfileirar como acontece com foto e anexo.
  let voice_calls: VoiceCallRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("voice_calls")
      .select(
        "id, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at, duration_ms",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] voice calls load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      voice_calls = data as VoiceCallRow[];
    }
  }

  // Identidade em canal externo (migration 0277) — a MESMA classe dos blocos
  // acima, achada pelo gate `tests/unit/lgpd-exporta-o-que-redige.test.ts`: o
  // passo 7c de `fn_lgpd_cascade_redact_contact` redige handle/display_name/
  // avatar_url ao anonimizar, e o que se apaga a pedido do titular é o que se
  // entrega a pedido dele.
  let channel_identities: ChannelIdentityRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("contact_channel_identities")
      .select("id, channel, external_id, handle, display_name, avatar_url, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] channel identities load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      channel_identities = data;
    }
  }

  // Campanhas — `contact_id` direto em `campaign_recipients` (migration 0343).
  let campaign_recipients: CampaignRecipientRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("campaign_recipients")
      .select(
        "id, campaign_id, status, eligibility_status, exclusion_reason, rendered_body, sent_at, delivered_at, read_at, replied_at, opted_out_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] campaign recipients load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      campaign_recipients = data as unknown as CampaignRecipientRow[];
    }
  }

  // Lista de exclusão de campanhas — `contact_id` direto (migration 0375).
  let campaign_suppressions: CampaignSuppressionRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("campaign_suppressions")
      .select("id, address_tail, reason, source, created_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      logger.warn("[lgpd-export-worker] campaign suppressions load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      campaign_suppressions = data as unknown as CampaignSuppressionRow[];
    }
  }

  // Captação por webhook — a MESMA classe do bloco acima, achada pelo gate.
  let webhook_captures: CaptureRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("webhook_lead_captures")
      .select(
        "id, source_name, outcome, captured_name, captured_phone, captured_email, fields, utm, remote_ip, user_agent, received_at",
      )
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("received_at", { ascending: false })
      .limit(500);
    if (error) {
      logger.warn("[lgpd-export-worker] webhook captures load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      webhook_captures = data;
    }
  }

  // Audit log extract (best-effort: rows where metadata.contact_id matches).
  let audit_log_extract: AuditRow[] = [];
  if (contactId) {
    const { data, error } = await admin
      .from("api_audit_log")
      .select("id, action, resource_type, resource_id, created_at, metadata")
      .eq("organization_id", organizationId)
      .or(`resource_id.eq.${contactId},metadata->>contact_id.eq.${contactId}`)
      .order("created_at", { ascending: false })
      .limit(AUDIT_LIMIT);
    if (error) {
      logger.warn("[lgpd-export-worker] audit load failed", {
        request_id: requestId,
        error: error.message,
      });
    } else if (data) {
      audit_log_extract = data.map((a) => ({
        id: a.id,
        action: a.action,
        resource_type: a.resource_type,
        resource_id: a.resource_id,
        created_at: a.created_at,
      }));
    }
  }

  // A 0226/0229 redige estes registros. Só o FK de contato e os compromissos
  // comprovados abaixo dão escopo: nunca o conteúdo livre de um aviso ou a
  // autorização privada do job. Paginar os IDs evita perder avisos de consultas
  // antigas além do recorte de appointments mostrado no relatório.
  const reply_drafts: NonNullable<ExportPayload["reply_drafts"]> = [];
  if (contactId) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await admin
        .from("ai_reply_drafts")
        .select("id,status,original_body,edited_body,approved_body,proposals,feedback,created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + 499);
      if (error) throw error;
      reply_drafts.push(...(data ?? []));
      if (!data || data.length < 500) break;
    }
  }
  // Notas internas: sem FK para `contacts`, só para `conversations` — o escopo
  // são as conversas do titular já carregadas acima.
  const conversation_notes: NonNullable<ExportPayload["conversation_notes"]> = [];
  const conversationIds = conversations.map((c) => c.id);
  for (let batch = 0; batch < conversationIds.length; batch += 100) {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await admin
        .from("conversation_notes")
        .select("id, conversation_id, body, media_storage_path, media_mime, media_size_bytes, created_at, created_by_name")
        .eq("organization_id", organizationId)
        .in("conversation_id", conversationIds.slice(batch, batch + 100))
        .order("id")
        .range(offset, offset + 499);
      if (error) throw error;
      conversation_notes.push(...(data ?? []));
      if (!data || data.length < 500) break;
    }
  }
  // Memória da IA, registros de execução e estado da lead. As três têm
  // `contact_id` + `organization_id` na própria linha. `.from("<tabela>")`
  // literal de propósito: é o que `tests/unit/lgpd-exporta-o-que-redige.test.ts`
  // enxerga ao conferir que o export visita o que a redação alcança.
  const lead_notes: NonNullable<ExportPayload["lead_notes"]> = [];
  const ai_agent_runs: NonNullable<ExportPayload["ai_agent_runs"]> = [];
  const lead_state: NonNullable<ExportPayload["lead_state"]> = [];
  const instagram_comments: InstagramCommentRow[] = [];
  const cases: CaseRow[] = [];
  const case_events: CaseEventRow[] = [];
  const demandas: DemandaRow[] = [];
  const avisos_da_central: CentralNoticeRow[] = [];
  if (contactId) {
    const titular = contactId;
    const paginar = async <T,>(
      pagina: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
    ): Promise<T[]> => {
      const linhas: T[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await pagina(offset, offset + 499);
        if (error) throw error;
        linhas.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      return linhas;
    };
    lead_notes.push(
      ...(await paginar((de, ate) =>
        admin
          .from("lead_notes")
          .select("id, headline, body, created_at, updated_at")
          .eq("organization_id", organizationId)
          .eq("contact_id", titular)
          .order("id")
          .range(de, ate),
      )),
    );
    for (const run of await paginar((de, ate) =>
      admin
        .from("ai_agent_runs")
        .select("id, tool_calls, created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", titular)
        .order("id")
        .range(de, ate),
    )) {
      ai_agent_runs.push({ ...run, tool_calls: toolCallsParaOTitular(run.tool_calls) });
    }
    lead_state.push(
      ...(await paginar((de, ate) =>
        admin
          .from("lead_state")
          .select("id, next_action, qualification, updated_at")
          .eq("organization_id", organizationId)
          .eq("contact_id", titular)
          .order("id")
          .range(de, ate),
      )),
    );
    // Comentários do Instagram. A ingestão não grava `contact_id`: quem liga o
    // comentário à pessoa é o IGSID de quem comentou — os mesmos dois braços do
    // passo 7c-1 da cascata. Identidade já anonimizada não tem mais IGSID.
    const colunasDoComentario =
      "id, media_id, texto, autor_handle, comentado_em, situacao, sugestao_de_resposta, motivo_do_toque";
    const igsids = channel_identities
      .filter((i) => i.channel === "instagram" && !i.external_id.startsWith("anonimizado:"))
      .map((i) => i.external_id);
    const comentarios = await paginar<InstagramCommentRow>((de, ate) =>
      admin
        .from("instagram_comments")
        .select(colunasDoComentario)
        .eq("organization_id", organizationId)
        .eq("contact_id", titular)
        .order("id")
        .range(de, ate),
    );
    if (igsids.length > 0) {
      comentarios.push(
        ...(await paginar<InstagramCommentRow>((de, ate) =>
          admin
            .from("instagram_comments")
            .select(colunasDoComentario)
            .eq("organization_id", organizationId)
            .in("autor_igsid", igsids)
            .order("id")
            .range(de, ate),
        )),
      );
    }
    const vistos = new Set<string>();
    for (const c of comentarios) {
      if (vistos.has(c.id)) continue;
      vistos.add(c.id);
      instagram_comments.push(c);
    }

    // Casos, linha do tempo, demandas e avisos — o que a 0317 pôs na cascata.
    // O escopo do CASO é a conversa do titular (`agent_cases` não tem FK para
    // `contacts`); o do evento é o caso já coletado — um `case_id` fora de
    // `cases` seria de outro titular.
    const EM_LOTE = 100; // Mantém o filtro IN abaixo dos limites de URL dos proxies.
    for (let lote = 0; lote < conversationIds.length; lote += EM_LOTE) {
      const ids = conversationIds.slice(lote, lote + EM_LOTE);
      cases.push(
        ...(await paginar<CaseRow>((de, ate) =>
          admin
            .from("agent_cases")
            .select("id, conversation_id, status, title, summary, blocker, source, opened_at, closed_at, created_at")
            .eq("organization_id", organizationId)
            .in("conversation_id", ids)
            .order("id")
            .range(de, ate),
        )),
      );
    }
    const caseIds = cases.map((caso) => caso.id);
    for (let lote = 0; lote < caseIds.length; lote += EM_LOTE) {
      const ids = caseIds.slice(lote, lote + EM_LOTE);
      case_events.push(
        ...(await paginar<CaseEventRow>((de, ate) =>
          admin
            .from("agent_case_events")
            .select("id, case_id, kind, actor_kind, human_action, body, metadata, created_at")
            .eq("organization_id", organizationId)
            .in("case_id", ids)
            .order("id")
            .range(de, ate),
        )),
      );
    }
    demandas.push(
      ...(await paginar<DemandaRow>((de, ate) =>
        admin
          .from("demandas")
          .select("id, agent_case_id, origem, assunto, estado, dono_kind, proximo_passo, desfecho, aberta_em, fechada_em")
          .eq("organization_id", organizationId)
          .eq("contact_id", titular)
          .order("id")
          .range(de, ate),
      )),
    );
    // Avisos: a referência é polimórfica (sem FK), então o escopo são os ids
    // que comprovadamente são do titular — ele, as conversas e os casos dele.
    // Os de compromisso já saem em `appointment_notices`.
    const referencias = [titular, ...conversationIds, ...caseIds];
    for (let lote = 0; lote < referencias.length; lote += EM_LOTE) {
      const ids = referencias.slice(lote, lote + EM_LOTE);
      avisos_da_central.push(
        ...(await paginar<CentralNoticeRow>((de, ate) =>
          admin
            .from("agent_inbox_items")
            .select("id, kind, title, body, status, created_at, resolved_at")
            .eq("organization_id", organizationId)
            .in("ref_id", ids)
            .order("id")
            .range(de, ate),
        )),
      );
    }
  }
  const meeting_deliveries: MeetingDeliveryRow[] = [];
  const appointment_notices: AppointmentNoticeRow[] = [];
  if (contactId) {
    const appointmentIds = new Set<string>();
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) {
        logger.warn("[lgpd-export-worker] meeting references load failed", {
          request_id: requestId,
        });
        break;
      }
      for (const appointment of data ?? []) appointmentIds.add(appointment.id);
      if (!data || data.length < pageSize) break;
    }
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await admin
        .from("job_queue")
        .select("id,status,created_at,run_after,appointment_id:payload->>appointment_id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("kind", "transactional_delivery")
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) {
        logger.warn("[lgpd-export-worker] meeting deliveries load failed", {
          request_id: requestId,
        });
        break;
      }
      for (const job of data ?? [])
        meeting_deliveries.push({
          id: job.id,
          status: job.status,
          created_at: job.created_at,
          run_after: job.run_after,
          appointment_id:
            typeof job.appointment_id === "string" && appointmentIds.has(job.appointment_id)
              ? job.appointment_id
              : null,
        });
      if (!data || data.length < pageSize) break;
    }
    const ids = [...appointmentIds];
    const refBatchSize = 100; // Mantém o filtro IN abaixo dos limites de URL dos proxies.
    for (let batch = 0; batch < ids.length; batch += refBatchSize) {
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await admin
          .from("agent_inbox_items")
          .select("id,ref_id,title,body,status,created_at,resolved_at")
          .eq("organization_id", organizationId)
          .eq("ref_kind", "appointment")
          .in("kind", ["other", "appointment_outcome_required", "appointment_recovery_review"])
          .in("ref_id", ids.slice(batch, batch + refBatchSize))
          .order("id")
          .range(offset, offset + pageSize - 1);
        if (error) {
          logger.warn("[lgpd-export-worker] appointment notices load failed", {
            request_id: requestId,
          });
          break;
        }
        for (const notice of data ?? [])
          appointment_notices.push({
            id: notice.id,
            ref_id: notice.ref_id,
            title: notice.title,
            body: notice.body,
            status: notice.status,
            created_at: notice.created_at,
            resolved_at: notice.resolved_at,
          });
        if (!data || data.length < pageSize) break;
      }
    }
  }

  return {
    request_id: requestId,
    organization_id: organizationId,
    organization_legal_name: controlador.legal_name,
    organization_display_name: controlador.display_name,
    dpo_email: controlador.dpo_email,
    generated_at: new Date().toISOString(),
    no_local_footprint: !contact && conversations.length === 0 && orders.length === 0,
    contact,
    consents,
    conversations,
    messages_count_total,
    messages_recent,
    leads,
    orders,
    activities,
    checkpoints,
    appointments,
    tasks,
    webhook_captures,
    audit_log_extract,
    reply_drafts,
    conversation_notes,
    meeting_deliveries,
    appointment_notices,
    voice_calls,
    channel_identities,
    lead_notes,
    ai_agent_runs,
    lead_state,
    instagram_comments,
    cases,
    case_events,
    demandas,
    avisos_da_central,
    campaign_recipients,
    campaign_suppressions,
  };
}

function emptyPayload(
  requestId: string,
  organizationId: string,
  controlador: Controlador,
): ExportPayload {
  return {
    request_id: requestId,
    organization_id: organizationId,
    organization_legal_name: controlador.legal_name,
    organization_display_name: controlador.display_name,
    dpo_email: controlador.dpo_email,
    generated_at: new Date().toISOString(),
    no_local_footprint: true,
    contact: null,
    consents: [],
    conversations: [],
    messages_count_total: 0,
    messages_recent: [],
    leads: [],
    orders: [],
    activities: [],
    appointments: [],
    tasks: [],
    webhook_captures: [],
    audit_log_extract: [],
    meeting_deliveries: [],
    appointment_notices: [],
    voice_calls: [],
    channel_identities: [],
    lead_notes: [],
    ai_agent_runs: [],
    lead_state: [],
    campaign_recipients: [],
    campaign_suppressions: [],
  };
}
