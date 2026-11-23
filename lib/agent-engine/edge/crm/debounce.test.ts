/**
 * A janela de rajada ANDA e para no TETO (porte do upstream #4977).
 *
 * O cenário de produção de lá: 3 bolhas do mesmo contato com gaps de 12,1 s e
 * 17,5 s. O dublê abaixo aplica a MESMA regra de candidato que a consulta do
 * drain (`run_after > now()` OU `created_at + teto > now()`) e a extensão real
 * (`estenderJanelaDaRajada`), com relógio do cenário — nada de timer.
 */
import { expect, it, vi } from 'vitest';
import type pg from 'pg';

import { loadEnv } from '../../env';

import { emMs, estenderJanelaDaRajada, janelaEstendidaAte, tetoDaRajada } from './debounce';

const T0 = 1_700_000_000_000;
const DEBOUNCE = 8_000;
const GAPS = [0, 12_100, 29_600] as const;

/** Simula as chegadas; devolve quantos jobs nasceram e para onde cada um foi. */
async function simular(chegadas: readonly number[], tetoMs: number | undefined) {
  const jobs: { id: string; created_at: Date; run_after: Date }[] = [];
  const teto = tetoDaRajada(tetoMs, DEBOUNCE);
  const query = vi.fn(async (_sql: string, p: unknown[]) => {
    const job = jobs.find((j) => j.id === p[0]);
    if (job) job.run_after = new Date(String(p[1]));
    return { rows: [] };
  });
  const pool = { query } as unknown as pg.Pool;
  for (const em of chegadas.map((c) => T0 + c)) {
    const candidato = jobs.find(
      (j) => j.run_after.getTime() > em || j.created_at.getTime() + teto > em,
    );
    if (candidato) {
      await estenderJanelaDaRajada(pool, 'org1', candidato, { agora: em, debounceMs: DEBOUNCE, tetoMs: teto });
      continue;
    }
    jobs.push({ id: `job-${jobs.length + 1}`, created_at: new Date(em), run_after: new Date(em + DEBOUNCE) });
  }
  return jobs;
}

it('REPRODUZ o defeito: sem teto, gaps de 12,1 s e 17,5 s dão TRÊS turnos', async () => {
  expect(await simular(GAPS, undefined)).toHaveLength(3);
});

it('com teto de 45 s a mesma rajada vira UM turno, e o run_after anda até 29,6 s + 8 s', async () => {
  const jobs = await simular(GAPS, 45_000);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.run_after.getTime()).toBe(T0 + 37_600);
});

it('contato que não para: o primeiro job encosta no teto e a bolha seguinte abre rajada nova', async () => {
  const chegadas = Array.from({ length: 15 }, (_, i) => i * 5_000); // 0..70 s
  const jobs = await simular(chegadas, 45_000);
  expect(jobs).toHaveLength(2);
  expect(jobs[0]!.run_after.getTime()).toBe(T0 + 45_000);
  expect(jobs[1]!.created_at.getTime()).toBe(T0 + 45_000);
  expect(jobs[1]!.run_after.getTime()).toBe(T0 + 70_000 + DEBOUNCE);
});

it('teto de 30 s cobre a rajada medida por 0,4 s; 25 s já a parte em dois', async () => {
  const trinta = await simular(GAPS, 30_000);
  expect(trinta).toHaveLength(1);
  expect(trinta[0]!.run_after.getTime()).toBe(T0 + 30_000);
  expect(await simular(GAPS, 25_000)).toHaveLength(2);
});

it('tetoDaRajada: 0/ausente é a janela ancorada; teto menor que a janela vale a janela', () => {
  expect(tetoDaRajada(undefined, 8_000)).toBe(8_000);
  expect(tetoDaRajada(0, 8_000)).toBe(8_000);
  expect(tetoDaRajada(45_000, 8_000)).toBe(45_000);
  expect(tetoDaRajada(1_000, 8_000)).toBe(8_000);
  expect(tetoDaRajada(45_000, 0)).toBe(0);
});

it('janelaEstendidaAte: agora + debounce, nunca além do teto', () => {
  expect(janelaEstendidaAte(T0, 45_000, 8_000, T0 + 12_100)).toBe(T0 + 20_100);
  expect(janelaEstendidaAte(T0, 45_000, 8_000, T0 + 44_000)).toBe(T0 + 45_000);
});

it('emMs aceita Date e ISO, recusa o resto', () => {
  expect(emMs(new Date(T0))).toBe(T0);
  expect(emMs(new Date(T0).toISOString())).toBe(T0);
  expect(emMs(null)).toBeNull();
  expect(emMs('lixo')).toBeNull();
  expect(emMs(42)).toBeNull();
});

it('job adiado pela janela de resposta nunca é ENCURTADO, e no teto não há UPDATE', async () => {
  const query = vi.fn();
  const pool = { query } as unknown as pg.Pool;
  const adiado = { id: 'j', created_at: new Date(T0), run_after: new Date(T0 + 12 * 3_600_000) };
  expect(await estenderJanelaDaRajada(pool, 'org1', adiado, { agora: T0, debounceMs: 8_000, tetoMs: 45_000 }))
    .toEqual({ ate: null });
  const noTeto = { id: 'j', created_at: new Date(T0), run_after: new Date(T0 + 45_000) };
  expect(await estenderJanelaDaRajada(pool, 'org1', noTeto, { agora: T0 + 44_000, debounceMs: 8_000, tetoMs: 45_000 }))
    .toEqual({ ate: null });
  expect(query).not.toHaveBeenCalled();
});

it('falha no UPDATE não lança: devolve o erro para o drain logar', async () => {
  const pool = { query: vi.fn().mockRejectedValue(new Error('deadlock detected')) } as unknown as pg.Pool;
  const job = { id: 'j', created_at: new Date(T0), run_after: new Date(T0 + 8_000) };
  expect(await estenderJanelaDaRajada(pool, 'org1', job, { agora: T0 + 12_100, debounceMs: 8_000, tetoMs: 45_000 }))
    .toEqual({ ate: null, erro: 'deadlock detected' });
});

it('INBOUND_BURST_MAX_MS: 45 s por padrão', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    SUPABASE_DB_URL: 'postgres://user:pass@127.0.0.1:5432/db',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste',
  });
  expect(env.INBOUND_BURST_MAX_MS).toBe(45_000);
  expect(tetoDaRajada(env.INBOUND_BURST_MAX_MS, env.INBOUND_DEBOUNCE_MS)).toBe(45_000);
});
