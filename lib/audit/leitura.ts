/**
 * Auditoria de LEITURA de dado de paciente (achado A8, auditoria 2026-09-29).
 *
 * Mesmo `api_audit_log`, com `metadata.acesso = "leitura"` para separar de
 * mutação. Fire-and-forget de verdade: não devolve promessa, então a rota não
 * espera o INSERT — a leitura não fica mais lenta nem falha por causa da
 * trilha (e `audit()` já não lança; falha vira alerta Sentry).
 *
 * Listagens: 1 linha por página, com os ids em `metadata.ids`, nunca 1 por item.
 *
 * Limite conhecido: leitura direta pela REST do Supabase (anon key + sessão) não
 * passa por aqui. Só entra na trilha o que passa por rota ou RPC auditada.
 */
import { audit, type AuditEntry } from "@/lib/audit";

export const ACOES_DE_LEITURA = [
  "contact.viewed",
  "contact.listed",
  "conversation.viewed",
  "message.media_viewed",
  "prontuario.contact_read",
  "lgpd.request_previewed",
] as const;

export type AcaoDeLeitura = (typeof ACOES_DE_LEITURA)[number];

export function auditarLeitura(e: Omit<AuditEntry, "action"> & { action: AcaoDeLeitura }): void {
  // `Promise.resolve().then` e não `audit(...).catch`: nem um throw síncrono
  // nem um retorno que não seja promessa (mock, wrapper) chega à rota.
  void Promise.resolve()
    .then(() => audit({ ...e, metadata: { ...e.metadata, acesso: "leitura" } }))
    .catch(() => {});
}
