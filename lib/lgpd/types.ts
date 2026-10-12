/**
 * LGPD domain types for DeskcommCRM.
 * Mapped from docs/specs/01-spec-platform-base.md §8.1 and Spec 06 §5.6.
 */

/**
 * Os TRÊS valores que o banco aceita — `lgpd_requests_request_type_check`.
 *
 * A UI e as rotas usavam `customer_redact`/`customer_data_request`, que o CHECK
 * REJEITA: todo pedido criado com esse vocabulário estourava no INSERT, e o
 * filtro por tipo na tela nunca casava com nada. Se for preciso renomear, o
 * caminho é migration primeiro, este tipo depois — nunca só aqui.
 */
export type LgpdRequestType = "data_request" | "redact" | "store_redact";

/** Rótulo em pt-BR — fonte única, para as cinco telas não divergirem. */
export const LGPD_REQUEST_TYPE_LABELS: Record<LgpdRequestType, string> = {
  data_request: "Solicitação de dados",
  redact: "Anonimização cliente",
  store_redact: "Anonimização tenant",
};

export type LgpdScope = "contact" | "tenant";

/**
 * Os SEIS estados que o banco aceita: `lgpd_requests_status_check` (migration 0356).
 *
 * Desde o EPIC-08 esta lista teve `pending_review` e o CHECK não: o worker gravava o
 * estado, o banco recusava (23514) e o pedido ficava em "Processando" para
 * sempre. O par está preso em `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 * Estado novo: migration primeiro, esta lista depois, nunca só aqui.
 *
 * `expired` existe no banco desde a origem e hoje ninguém o grava; está aqui
 * para a tela saber rotular a linha se um dia aparecer.
 */
export const LGPD_REQUEST_STATUSES = [
  "received",
  "processing",
  "completed",
  "failed",
  "expired",
  "pending_review",
] as const;

export type LgpdRequestStatus = (typeof LGPD_REQUEST_STATUSES)[number];

/**
 * De onde o pedido veio: `lgpd_requests_source_check`. Este tipo dizia
 * `admin_panel`, que o CHECK recusa; quem criasse um pedido "pelo painel" com
 * ele estouraria no INSERT.
 */
export type LgpdRequestSource = "nuvemshop" | "manual" | "api" | "support";

export interface LgpdRequest {
  id: string;
  organization_id: string;
  request_type: LgpdRequestType;
  /** Origin channel that triggered the request. */
  source: LgpdRequestSource;
  /** Internal contact id (may be null if contact not yet in CRM — L-03). */
  contact_id: string | null;
  /** Nuvemshop customer id or other external platform identifier. */
  external_customer_id: string | null;
  status: LgpdRequestStatus;
  attempts: number;
  received_at: string; // ISO 8601 UTC
  due_at: string; // ISO 8601 UTC
  completed_at: string | null;
  /** Raw webhook payload + context. PII stored here, never in audit log. */
  request_payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  cascaded_to: Record<string, unknown> | null;
  /** Whether this request is high-priority (drives early SLA alarms). */
  emergency: boolean;
  /** Scope of the request: 'contact' (single customer) or 'tenant' (full store uninstall). */
  scope: LgpdScope;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// PEDIDO REGISTRADO PELA EQUIPE (source = 'manual')
//
// Nada disto é coluna nova: o canal, a observação e o e-mail de entrega moram em
// `request_payload` (é onde o webhook já guarda o dado pessoal do pedido), e a
// entrega em mãos mora em `result.manual_delivery`.
// ---------------------------------------------------------------------------

/** Por onde o titular pediu. Vai em `request_payload.channel`. */
export const LGPD_CANAIS_DE_CHEGADA = ["whatsapp", "email", "presencial", "telefone"] as const;
export type LgpdCanalDeChegada = (typeof LGPD_CANAIS_DE_CHEGADA)[number];

export const LGPD_CANAL_LABELS: Record<LgpdCanalDeChegada, string> = {
  whatsapp: "WhatsApp",
  email: "E-mail",
  presencial: "Pessoalmente",
  telefone: "Telefone",
};

/** Como o relatório foi entregue à mão. Vai em `result.manual_delivery.method`. */
export const LGPD_FORMAS_DE_ENTREGA = ["presencial", "email", "whatsapp"] as const;
export type LgpdFormaDeEntrega = (typeof LGPD_FORMAS_DE_ENTREGA)[number];

/** Os tipos que a equipe registra. `store_redact` é da loja inteira: só o webhook cria. */
export const LGPD_TIPOS_REGISTRAVEIS = ["data_request", "redact"] as const;

/**
 * Dias ÚTEIS de prazo por tipo, os mesmos que os webhooks usam (CLAUDE.md, LGPD:
 * cópia dos dados em D+7, anonimização em D+15).
 */
export const LGPD_PRAZO_EM_DIAS_UTEIS: Record<(typeof LGPD_TIPOS_REGISTRAVEIS)[number], number> = {
  data_request: 7,
  redact: 15,
};

/** Estados em que o pedido ainda está ABERTO: é o que a regra de duplicata olha. */
export const LGPD_ESTADOS_ABERTOS = ["received", "processing", "pending_review"] as const satisfies readonly LgpdRequestStatus[];
