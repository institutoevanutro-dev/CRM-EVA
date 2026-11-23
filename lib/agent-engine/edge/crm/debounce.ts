/**
 * A janela de rajada do inbound ANDA e para no TETO (porte do upstream #4977,
 * issue #196 de lá).
 *
 * Até aqui a janela era ANCORADA no primeiro job: `run_after = created_at +
 * INBOUND_DEBOUNCE_MS`, fixado na criação, e nada o empurrava. Rajada humana
 * típica — bolhas de WhatsApp com 10 a 20 s de intervalo — caía fora: cada bolha
 * que chegava depois do `run_after` abria job novo, e o agente respondia bolha
 * por bolha. Medido lá: 3 mensagens do mesmo contato, gaps de 12,1 s e 17,5 s
 * (rajada de 29,6 s), zero coalescência, 3 turnos.
 *
 * Agora a mensagem que encontra o job da rajada o EMPURRA (`run_after = agora +
 * debounce`) e o job segue aceitando carona até o TETO contado da PRIMEIRA
 * mensagem (`created_at + INBOUND_BURST_MAX_MS`). O teto impede que o contato
 * que não para de escrever adie a resposta para sempre: passado ele, a próxima
 * mensagem abre rajada nova.
 *
 * A consulta do candidato mora no drain (`drain.ts`), com as cercas do fork
 * (mesma conversa, sem passagem feita, sem envio em voo). Aqui ficam a
 * aritmética, pura, e a única escrita: o UPDATE que empurra a janela.
 */
import type pg from 'pg';

/**
 * Teto EFETIVO da rajada.
 *
 * `tetoMs` ausente ou `0` = janela ANCORADA (o `run_after` nasce e não anda): é
 * o opt-out explícito e o comportamento de quem não passa o knob. Teto menor
 * que a janela resolve para a janela: senão o teto venceria antes de o job
 * nascer claimável, e o defeito voltaria.
 */
export function tetoDaRajada(tetoMs: number | null | undefined, debounceMs: number): number {
  if (debounceMs <= 0) return 0;
  if (tetoMs === null || tetoMs === undefined || tetoMs <= 0) return debounceMs;
  return Math.max(tetoMs, debounceMs);
}

/** Para onde a janela vai: `agora + debounce`, NUNCA além de `created_at + teto`. */
export function janelaEstendidaAte(
  criadoEm: number,
  tetoMs: number,
  debounceMs: number,
  agora: number,
): number {
  return Math.min(agora + debounceMs, criadoEm + tetoMs);
}

/**
 * `Date`/ISO → ms; o que não for data vira `null`. `created_at` e `run_after`
 * chegam `Date` pelo driver `pg` e string por dublê/payload: recusar um dos dois
 * devolveria `null`, e a janela simplesmente não andaria, sem erro nenhum.
 */
export function emMs(valor: unknown): number | null {
  if (valor === null || valor === undefined) return null;
  if (!(valor instanceof Date) && typeof valor !== 'string') return null;
  const ms = valor instanceof Date ? valor.getTime() : new Date(valor).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Guardas do UPDATE, todas de propósito: `status = 'pending'` (o claim pode ter
 * vencido a corrida desde o SELECT, e job claimado não tem o horário mexido);
 * `organization_id` (o drain roda com service role, sem RLS); `kind`.
 */
const SQL_ESTENDER_JANELA = `update job_queue set run_after = $2::timestamptz
 where id = $1 and organization_id = $3 and kind = 'inbound_turn' and status = 'pending'`;

/**
 * Empurra a janela do job da rajada, respeitando o teto.
 *
 * NÃO LANÇA: falhar aqui devolve o comportamento ancorado — pior, mas sem perder
 * mensagem, que já está na carona. O erro sobe em `erro` para o chamador logar.
 * Nunca ENCURTA: job adiado pela janela de resposta (`run_after` às 07:00) ou já
 * encostado no teto fica onde está.
 */
export async function estenderJanelaDaRajada(
  pool: pg.Pool,
  organizationId: string,
  candidato: { id: string; created_at?: unknown; run_after?: unknown },
  p: { agora: number; debounceMs: number; tetoMs: number },
): Promise<{ ate: Date | null; erro?: string }> {
  const criadoEm = emMs(candidato.created_at);
  const runAfterEm = emMs(candidato.run_after);
  if (criadoEm === null || runAfterEm === null) return { ate: null };
  const alvoEm = janelaEstendidaAte(criadoEm, p.tetoMs, p.debounceMs, p.agora);
  if (alvoEm <= runAfterEm) return { ate: null };
  try {
    await pool.query(SQL_ESTENDER_JANELA, [candidato.id, new Date(alvoEm).toISOString(), organizationId]);
    return { ate: new Date(alvoEm) };
  } catch (err) {
    return { ate: null, erro: err instanceof Error ? err.message : String(err) };
  }
}
