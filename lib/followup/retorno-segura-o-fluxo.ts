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
 * Com um retorno VIVO, ou um que SAIU há menos da folga do fluxo (`folgaDepoisDoRetorno`):
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

/**
 * Menor espera depois de um retorno, qualquer que seja o gatilho do fluxo. É a
 * proteção da issue #2907: com gatilho de 40 min, o retorno saiu às 18:56 e o
 * "Follow-up 1" às 18:58 — duas mensagens seguidas sem o lead responder.
 */
export const PISO_DA_FOLGA_DEPOIS_DO_RETORNO_MS = 4 * 3_600_000;

/**
 * Quanto o fluxo de silêncio espera DEPOIS do retorno antes de falar: o retorno
 * conta como a última conversa e o relógio do silêncio recomeça dali — o próprio
 * gatilho do fluxo (`threshold_minutes`), nunca menos que o piso. O fluxo de 3
 * dias espera 3 dias; o de 1 h e o de 40 min esperam 4 h. Antes era 1 dia para
 * todos: o fluxo de 1 h ficava um dia parado depois do retorno.
 * Portado do projeto original (DeskcommCRM, PR #3808, que substitui o #3692).
 */
export function folgaDepoisDoRetorno(gatilhoMinutos: number): number {
  return Math.max(gatilhoMinutos * 60_000, PISO_DA_FOLGA_DEPOIS_DO_RETORNO_MS);
}

export function reavaliarDepoisDoRetorno(quandoDoRetorno: string, gatilhoMinutos: number): string {
  return new Date(Date.parse(quandoDoRetorno) + folgaDepoisDoRetorno(gatilhoMinutos)).toISOString();
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

const jaSaidos = (admin: SupabaseClient, orgId: string, folgaMs: number, agora: Date) =>
  retornos(admin, orgId)
    .eq("enabled", false)
    .is("last_error", null)
    .lte("next_run_at", agora.toISOString())
    .gt("next_run_at", new Date(agora.getTime() - folgaMs).toISOString());

type Linha = { contact_id: string | null; next_run_at: string };

/** A janela refeita no cliente: data torta que escapasse da consulta não segura para sempre. */
function saiuDentroDaFolga(row: Linha, folgaMs: number, agora: Date): boolean {
  const quando = Date.parse(row.next_run_at);
  return !Number.isNaN(quando) && quando <= agora.getTime() && quando > agora.getTime() - folgaMs;
}

/**
 * Contatos que o retorno ainda segura (vivo ou recém-saído): a varredura de silêncio os pula.
 * `folgaMs` é a do fluxo que pergunta (`folgaDepoisDoRetorno`): cada fluxo tem o seu gatilho.
 */
export async function contatosQueORetornoSegura(
  admin: SupabaseClient,
  orgId: string,
  folgaMs: number,
  agora: Date = new Date(),
): Promise<Set<string>> {
  const [v, s] = await Promise.all([vivos(admin, orgId), jaSaidos(admin, orgId, folgaMs, agora)]);
  if (v.error) throw new Error(`retorno_vivo_query_failed: ${v.error.message}`);
  if (s.error) throw new Error(`retorno_disparado_query_failed: ${s.error.message}`);
  const ids = new Set<string>();
  for (const row of (v.data ?? []) as Linha[]) if (row.contact_id) ids.add(row.contact_id);
  for (const row of (s.data ?? []) as Linha[]) if (row.contact_id && saiuDentroDaFolga(row, folgaMs, agora)) ids.add(row.contact_id);
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
  folgaMs: number,
  agora: Date = new Date(),
): Promise<string | null> {
  const [v, s] = await Promise.all([
    vivos(admin, orgId).eq("contact_id", contactId).order("next_run_at", { ascending: false }).limit(1),
    jaSaidos(admin, orgId, folgaMs, agora).eq("contact_id", contactId).order("next_run_at", { ascending: false }).limit(1),
  ]);
  if (v.error) throw new Error(`retorno_vivo_query_failed: ${v.error.message}`);
  if (s.error) throw new Error(`retorno_disparado_query_failed: ${s.error.message}`);
  const candidatos = [
    ...((v.data ?? []) as Linha[]),
    ...((s.data ?? []) as Linha[]).filter((r) => saiuDentroDaFolga(r, folgaMs, agora)),
  ]
    .map((r) => r.next_run_at)
    .filter((q) => !Number.isNaN(Date.parse(q)));
  if (candidatos.length === 0) return null;
  return candidatos.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}
