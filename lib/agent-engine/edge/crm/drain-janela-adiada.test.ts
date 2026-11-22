/**
 * Porte de melgarafael/DeskcommCRM #3419: job adiado pela janela de RESPOSTA
 * que já abriu é acordado na mensagem nova, em vez de levar a mensagem de
 * carona até a abertura antiga. Janela fechada: carona como sempre.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { PACING_DEFAULTS } from '../../pacing/defaults';

const janela = vi.hoisted(() => ({ aberta: true }));
vi.mock('../../pacing/store', () => ({
  loadChannelKnobs: async () => ({
    knobs: {
      ...PACING_DEFAULTS,
      timezone: 'America/Sao_Paulo',
      allowSunday: true,
      respostaStartHour: 0,
      respostaEndHour: janela.aberta ? 24 : 0,
    },
    numberActivatedAt: null,
  }),
}));

import { drainTick } from './drain';

const knobs = { batchSize: 10, intervalMs: 0, idleIntervalMs: 0, debounceMs: 8000, reapTimeoutMs: 60000 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const event = {
  id: 'e1', organization_id: 'org1', attempts: 1,
  payload: {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    contact_id: '22222222-2222-4222-8222-222222222222',
    channel_session_id: '33333333-3333-4333-8333-333333333333',
    inbound_message_id: '44444444-4444-4444-8444-444444444444',
  },
};
const ADIADO = { adiado_por_janela: { tipo: 'resposta', abertura: '2026-11-23T10:00:00.000Z', janela: '7h-22h' } };

function pool(calls: string[], candidato: { payload: unknown } | null, acorda = true) {
  const query = vi.fn().mockImplementation((sql: string) => {
    calls.push(sql);
    if (sql.includes('returning e.id')) return { rows: [{ ...event, created_at: new Date().toISOString() }] };
    if (sql.includes('ai_dispatch_mode')) return { rows: [{ mode: null }] };
    if (sql.includes('is_group')) return { rows: [{ is_group: false }] };
    if (sql.includes('tem_agente')) return { rows: [{ tem_agente: true, tem_roteador: false }] };
    if (sql.includes("direction = 'inbound'")) return { rows: [{ id: event.payload.inbound_message_id }] };
    if (sql.includes('channel_metadata')) {
      return {
        rows: [{
          channel_metadata: { ai_gate: null, ai_gate_mode: null, ai_test_phone_numbers: [] },
          force_human: false, assignee_kind: 'ai', bot_silenced_until: null, ai_authorized_at: null, phone_number: null,
        }],
      };
    }
    if (sql.includes('media_derived_status')) return { rows: [{ type: 'text', media_derived_status: null }] };
    if (sql.includes('select id, payload from job_queue')) return { rows: candidato ? [{ id: 'job-adiado', ...candidato }] : [] };
    if (sql.includes('set run_after = now()')) return { rows: acorda ? [{ id: 'job-adiado' }] : [] };
    if (sql.includes('insert into job_queue')) return { rows: [{ id: 'job-novo' }] };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

it('janela aberta: acorda o job adiado e a mensagem vai nele (sem job novo)', async () => {
  janela.aberta = true;
  const calls: string[] = [];
  await drainTick(pool(calls, { payload: ADIADO }), knobs, log);
  expect(calls.some((s) => s.includes('set run_after = now()'))).toBe(true);
  expect(calls.some((s) => s.includes('insert into job_queue'))).toBe(false);
});

it('janela fechada: carona como sempre, ninguém acorda', async () => {
  janela.aberta = false;
  const calls: string[] = [];
  await drainTick(pool(calls, { payload: ADIADO }), knobs, log);
  expect(calls.some((s) => s.includes('set run_after = now()'))).toBe(false);
  expect(calls.some((s) => s.includes('insert into job_queue'))).toBe(false);
});

it('job sem o rastro (debounce de rajada) não é acordado nem consulta a janela', async () => {
  janela.aberta = true;
  const calls: string[] = [];
  await drainTick(pool(calls, { payload: { conversation_id: event.payload.conversation_id } }), knobs, log);
  expect(calls.some((s) => s.includes('set run_after = now()'))).toBe(false);
  expect(calls.some((s) => s.includes('insert into job_queue'))).toBe(false);
});

it('o job saiu do pendente-futuro no meio: a mensagem ganha job próprio', async () => {
  janela.aberta = true;
  const calls: string[] = [];
  await drainTick(pool(calls, { payload: ADIADO }, false), knobs, log);
  expect(calls.some((s) => s.includes('insert into job_queue'))).toBe(true);
});
