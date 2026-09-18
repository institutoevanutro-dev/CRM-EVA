import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createPgSupervisaoDb } from './db-pg';
import type { RevisaoRow, SupervisaoDb } from './executor';

const input: Parameters<SupervisaoDb['moverEtapaComTrava']>[0] = {
  organization_id: 'org', lead_id: 'lead', contact_id: 'contact', conversation_id: 'conv',
  de_etapa_id: 'a0000000-0000-4000-8000-000000000001', para_etapa_id: 'a0000000-0000-4000-8000-000000000002',
  stage_changed_at_esperado: '2026-09-17 10:00:00.123456+00', service_revision_esperada: '7',
  review_id: 'review', action_key: 'key', supervisor_agent_id: 'agent', trace_id: 'trace', motivo: 'motivo',
};
function adapter(change: Record<string, unknown> = {}, stamp = input.stage_changed_at_esperado) {
  const binding = { enabled: true, mode: 'executar', allowed_stage_moves: [{ to_stage_id: input.para_etapa_id, from_stage_ids: [input.de_etapa_id] }], ...change };
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('update crm_leads')) return { rows: args?.[4] === stamp ? [{ id: 'lead', pipeline_id: 'pipeline' }] : [] };
    if (sql.includes('from ai_supervision_bindings')) return { rows: [binding] };
    if (sql.includes('from contacts')) return { rows: [{ is_anonymized: false, force_human: false, ...change }] };
    if (sql.includes('from conversations')) return { rows: [{ service_revision: '7', humano: false, ...change }] };
    if (sql.includes('from crm_stages')) return { rows: [{ id: input.para_etapa_id, is_archived: false, is_won: false, is_lost: false, requires_human: false, ...change }] };
    if (sql.includes('from crm_leads')) return { rows: [{ id: 'lead', pipeline_id: 'pipeline', stage_id: input.de_etapa_id, status: 'open', stage_changed_at: sql.includes('stage_changed_at::text') ? stamp : new Date(stamp!) }] };
    if (sql.includes('insert into crm_lead_activities')) return { rows: [{ id: 'activity' }] };
    return { rows: [] };
  });
  return { db: createPgSupervisaoDb({ query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool), query };
}
describe('supervisão: adaptador da escrita', () => {
  it('preserva microssegundos da leitura até o CAS e rejeita outro carimbo', async () => {
    const { db } = adapter();
    const state = await db.lerEstado({ organization_id: 'org', contact_id: 'contact', conversation_id: 'conv', lead_id: 'lead' } as RevisaoRow);
    expect(state.lead?.stage_changed_at).toBe(input.stage_changed_at_esperado);
    expect(await db.moverEtapaComTrava({ ...input, stage_changed_at_esperado: state.lead!.stage_changed_at })).toEqual({ ok: true, ref: 'activity' });
    expect(await db.moverEtapaComTrava({ ...input, stage_changed_at_esperado: '2026-09-17 10:00:00.123457+00' })).toEqual({ ok: false, porque: 'conflito' });
  });
  it.each([{ enabled: false }, { mode: 'recomendar' }, { allowed_stage_moves: [] }, { force_human: true }, { is_anonymized: true }, { humano: true }, { requires_human: true }])('revalida autoridade sob trava: %j', async (change) => {
    const { db, query } = adapter(change);
    expect(await db.moverEtapaComTrava(input)).toEqual({ ok: false, porque: 'autorizacao_revogada' });
    expect(query.mock.calls.some(([sql]) => sql.includes('update crm_leads'))).toBe(false);
  });
  it('recuperação sem recibo nunca executa movimento novo', async () => {
    const { db, query } = adapter();
    expect(await db.moverEtapaComTrava({ ...input, somente_recuperar: true })).toEqual({ ok: false, porque: 'conflito' });
    expect(query.mock.calls.some(([sql]) => sql.includes('update crm_leads'))).toBe(false);
  });
});


it('recupera recibo existente mesmo depois da revogação, sem escrever', async () => {
  const query = vi.fn(async (sql: string) => ({ rows:sql.includes('from crm_lead_activities') ? [{ id:'receipt' }] : [] }));
  const db = createPgSupervisaoDb({ connect:async () => ({ query,release() {} }) } as unknown as pg.Pool);
  expect(await db.moverEtapaComTrava({ ...input,somente_recuperar:true })).toEqual({ ok:true,ref:'receipt' });
  expect(query.mock.calls.map(([sql]) => sql).some((sql) => sql.includes('update '))).toBe(false);
});
