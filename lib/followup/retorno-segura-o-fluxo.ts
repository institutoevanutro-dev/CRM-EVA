/**
 * O RETORNO AGENDADO SEGURA O FLUXO DE SILÊNCIO.
 *
 * Porte do DeskcommCRM original: a parte de retorno do commit b94446a5c (jmpo)
 * e o PR #2929 (@webtecnica, issue #2907).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * O agente agenda um retorno ("te escrevo às 18:55", `cron_jobs` one-shot) e o
 * fluxo de silêncio, que não sabia de retorno nenhum, escrevia por cima. E quando
 * o retorno SAÍA, a linha de `cron_jobs` deixava de ser "agendada"
 * (`enabled=false`), a varredura do minuto seguinte via o contato como só
 * silencioso e o 1º passo do fluxo saía logo depois: duas mensagens seguidas
 * para o paciente, sem ele ter respondido.
 *
 * ─── A regra ───────────────────────────────────────────────────────────────
 *
 * Com um retorno VIVO, ou um que SAIU há menos de `FOLGA_DEPOIS_DO_RETORNO_MS`:
 *   - a varredura não inscreve o contato (`contatosQueORetornoSegura`);
 *   - a inscrição que já andava fica segurada até a folga depois do retorno
 *     (`quandoDoRetornoQueSegura` + `reavaliarDepoisDoRetorno`). Se o cliente
 *     responder, o `cancel_on_reply` do fluxo decide como sempre.
 *
 * Só o gatilho de SILÊNCIO: fluxo por etapa ou por caso responde a um fato novo
 * e não deve esperar.
 *
 * ─── O que conta como retorno ──────────────────────────────────────────────
 *
 * Linha de `cron_jobs` `kind='at'`, `job_kind='followup_turn'`, sem
 * `cancelled_at`, que não é turno de passo de fluxo (`followup_enrollment_id`
 * no payload). Vivo: `enabled=true`. Saído: `enabled=false`, `last_error` nulo
 * (o disparo bem-sucedido grava nulo; a falha definitiva grava a razão, ver
 * `fireOneDue` em `lib/agent-engine/cron/scheduler.ts`) e `next_run_at` no
 * PASSADO: o cancelamento de emergência (opt-out, handoff) desliga pendentes
 * do futuro sem `cancelled_at`, e isso não é retorno que falou. O disparo não
 * move `next_run_at`, então ele é a âncora do "quando saiu".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Quanto o fluxo espera depois do retorno: o tempo de a pessoa ler e responder. */
export const FOLGA_DEPOIS_DO_RETORNO_MS = 24 * 3_600_000;

export function reavaliarDepoisDoRetorno(quandoDoRetorno: string): string {
  return new Date(Date.parse(quandoDoRetorno) + FOLGA_DEPOIS_DO_RETORNO_MS).toISOString();
}

function retornos(admin: SupabaseClient, orgId: string) {
  return admin
    .from("cron_jobs")
    .select("contact_id, next_run_at")
    .eq("organization_id", orgId)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .is("cancelled_at", null)
    .is("payload->>followup_enrollment_id", null);
}

const vivos = (admin: SupabaseClient, orgId: string) => retornos(admin, orgId).eq("enabled", true);

const jaSaidos = (admin: SupabaseClient, orgId: string, agora: Date) =>
  retornos(admin, orgId)
    .eq("enabled", false)
    .is("last_error", null)
    .lte("next_run_at", agora.toISOString())
    .gt("next_run_at", new Date(agora.getTime() - FOLGA_DEPOIS_DO_RETORNO_MS).toISOString());

type Linha = { contact_id: string | null; next_run_at: string };

/** A janela refeita no cliente: data torta que escapasse da consulta não segura para sempre. */
function saiuDentroDaFolga(row: Linha, agora: Date): boolean {
  const quando = Date.parse(row.next_run_at);
  return !Number.isNaN(quando) && quando <= agora.getTime() && quando > agora.getTime() - FOLGA_DEPOIS_DO_RETORNO_MS;
}

/** Contatos que o retorno ainda segura (vivo ou recém-saído): a varredura de silêncio os pula. */
export async function contatosQueORetornoSegura(
  admin: SupabaseClient,
  orgId: string,
  agora: Date = new Date(),
): Promise<Set<string>> {
  const [v, s] = await Promise.all([vivos(admin, orgId), jaSaidos(admin, orgId, agora)]);
  if (v.error) throw new Error(`retorno_vivo_query_failed: ${v.error.message}`);
  if (s.error) throw new Error(`retorno_disparado_query_failed: ${s.error.message}`);
  const ids = new Set<string>();
  for (const row of (v.data ?? []) as Linha[]) if (row.contact_id) ids.add(row.contact_id);
  for (const row of (s.data ?? []) as Linha[]) if (row.contact_id && saiuDentroDaFolga(row, agora)) ids.add(row.contact_id);
  return ids;
}

/**
 * `next_run_at` do retorno MAIS TARDIO que ainda segura o contato (vivo ou
 * recém-saído), ou `null`. O mais tardio porque é depois dele que o fluxo volta.
 */
export async function quandoDoRetornoQueSegura(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
  agora: Date = new Date(),
): Promise<string | null> {
  const [v, s] = await Promise.all([
    vivos(admin, orgId).eq("contact_id", contactId).order("next_run_at", { ascending: false }).limit(1),
    jaSaidos(admin, orgId, agora).eq("contact_id", contactId).order("next_run_at", { ascending: false }).limit(1),
  ]);
  if (v.error) throw new Error(`retorno_vivo_query_failed: ${v.error.message}`);
  if (s.error) throw new Error(`retorno_disparado_query_failed: ${s.error.message}`);
  const candidatos = [
    ...((v.data ?? []) as Linha[]),
    ...((s.data ?? []) as Linha[]).filter((r) => saiuDentroDaFolga(r, agora)),
  ]
    .map((r) => r.next_run_at)
    .filter((q) => !Number.isNaN(Date.parse(q)));
  if (candidatos.length === 0) return null;
  return candidatos.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}
