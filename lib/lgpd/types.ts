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
