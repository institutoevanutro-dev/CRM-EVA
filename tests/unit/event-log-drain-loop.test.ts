/**
 * O laço que roda os handlers do event_log dentro do worker.
 *
 * O que estes testes protegem, e por quê (medido em VPS, 2026-08-25): os
 * handlers só rodavam pelo cron `event-log-drain`, 1×/min. A cadeia
 * persist→derive de um áudio levava 103-188s — dois saltos de cron — enquanto o
 * drain do turno espera 45s pela transcrição e então responde sem ela. O agente
 * dizia "não consigo ouvir áudio" com o texto chegando ao banco meio minuto
 * depois. A transcrição em si levava 3,9s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/lib/agent-engine/obs/logger';
import type { DrainSummary } from '@/lib/event-log/drain';

const drainEventLog = vi.fn();
const ensureHandlersRegistered = vi.fn();
const createAdminClient = vi.fn(() => ({ marcador: 'admin' }));

vi.mock('@/lib/event-log/drain', () => ({ drainEventLog }));
vi.mock('@/lib/event-log/register-handlers', () => ({ ensureHandlersRegistered }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }));

const {
  _reiniciarProntidaoDoLaco,
  prontidaoDoLacoDeEventLog,
  proximaEspera,
  runEventLogDrainLoop,
} = await import('@/lib/event-log/drain-loop');

const knobs = { intervalMs: 2_000, idleIntervalMs: 10_000, staleSweepMs: 60_000, batchSize: 50 };
const vazio: DrainSummary = { scanned: 0, done: 0, retried: 0, failed: 0, dead: 0 };
// O dublê mantém o tipo do MOCK (`log.warn` é um `vi.fn()` que as asserções
// interrogam); o cast para `Logger` fica no ponto em que ele CRUZA a fronteira
// da função. `as never` apagava o objeto inteiro e derrubava o typecheck do
// CI, que roda `-p tsconfig.typecheck.json` e inclui `tests/`.
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const logger = log as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  createAdminClient.mockReturnValue({ marcador: 'admin' });
  _reiniciarProntidaoDoLaco();
});

describe('proximaEspera — a regra de ritmo', () => {
  it('tick que processou alguma linha mantém o laço rápido', () => {
    for (const campo of ['done', 'retried', 'failed', 'dead'] as const) {
      expect(proximaEspera({ ...vazio, scanned: 1, [campo]: 1 }, knobs)).toBe(knobs.intervalMs);
    }
  });

  it('tick ocioso recua para a espera longa', () => {
    expect(proximaEspera(vazio, knobs)).toBe(knobs.idleIntervalMs);
  });

  it('linha varrida mas NÃO processada conta como ocioso', () => {
    // É o caso de concorrência com o cron: o claim otimista de drainEventLog
    // devolve `scanned` alto e zero processado quando a outra instância chegou
    // antes. Contar isso como trabalho faria o laço girar rápido à toa toda vez
    // que o cron passasse.
    expect(proximaEspera({ ...vazio, scanned: 50 }, knobs)).toBe(knobs.idleIntervalMs);
  });
});

describe('runEventLogDrainLoop', () => {
  it('drena com o batchSize dos knobs e para quando abortado', async () => {
    const abort = new AbortController();
    drainEventLog.mockImplementation(() => {
      abort.abort();
      return Promise.resolve({ ...vazio, done: 1 });
    });

    await runEventLogDrainLoop({ ...knobs, intervalMs: 0, idleIntervalMs: 0 }, logger, abort.signal);

    expect(ensureHandlersRegistered).toHaveBeenCalledOnce();
    // O primeiro tick SEMPRE procura `processing` preso.
    expect(drainEventLog).toHaveBeenCalledWith({ marcador: 'admin' }, { limit: 50, varrerPresos: true });
  });

  it('admin client indisponível DESLIGA o laço sem derrubar o worker', async () => {
    // `@/lib/supabase/admin` importa `@/lib/env`, que faz throw no topo do
    // módulo quando falta variável obrigatória. Num `.env` enxuto, um import
    // estático mataria o worker INTEIRO — fila durável, cron e turnos — por
    // causa de um laço acessório. Ele tem que se desligar sozinho e avisar.
    //
    // `error`, e não o `warn` de antes: era o `warn` que fazia o laço desligado
    // parecer ruído — a #648 ficou dez dias assim, com o `/healthz` verde
    // (#604). A prontidão publicada é o que transforma isso em sinal visível.
    createAdminClient.mockImplementation(() => {
      throw new Error('env inválido — verifique no .env: INTERNAL_SECRET');
    });
    const abort = new AbortController();

    await expect(
      runEventLogDrainLoop(knobs, logger, abort.signal),
    ).resolves.toBeUndefined();

    expect(drainEventLog).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledOnce();
    expect(prontidaoDoLacoDeEventLog()).toEqual({
      carregado: false,
      motivo: expect.stringContaining('INTERNAL_SECRET'),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('erro num tick não interrompe o laço nem acelera as tentativas', async () => {
    const abort = new AbortController();
    let ticks = 0;
    drainEventLog.mockImplementation(() => {
      ticks += 1;
      if (ticks >= 3) abort.abort();
      return Promise.reject(new Error('banco fora do ar'));
    });

    await runEventLogDrainLoop({ ...knobs, intervalMs: 0, idleIntervalMs: 0 }, logger, abort.signal);

    expect(ticks).toBe(3);
    expect(log.error).toHaveBeenCalledTimes(3);
  });
});

describe('procura por `processing` preso — no máximo 1×/min, sem mexer no ritmo (#3701, parcial)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('procura no 1º tick e de novo só a cada `staleSweepMs`; o ocioso de 3 s não recua', async () => {
    const abort = new AbortController();
    const varreduras: Array<boolean | undefined> = [];
    let marcarPrimeiroTick!: () => void;
    const primeiroTick = new Promise<void>((r) => {
      marcarPrimeiroTick = r;
    });
    drainEventLog.mockImplementation((_admin: unknown, opts: { varrerPresos?: boolean }) => {
      varreduras.push(opts.varrerPresos);
      marcarPrimeiroTick();
      return Promise.resolve({ ...vazio, scanned: 1 });
    });

    const laco = runEventLogDrainLoop(
      { ...knobs, idleIntervalMs: 3_000, staleSweepMs: 60_000 },
      logger,
      abort.signal,
    );
    // O 1º tick é esperado numa promessa: o import dinâmico de carregarDepsDoLaco
    // roda em tempo real, e o caso tem de passar sozinho, com o cache frio.
    await primeiroTick;
    await vi.advanceTimersByTimeAsync(120_000);
    // Para o laço ANTES de afirmar: asserção vermelha não deixa o laço pendurado.
    abort.abort();
    await laco;

    expect(
      varreduras.length,
      'o ocioso de 3 s mudou: em 120 s deviam ser 41 passadas (0, 3, …, 120 s)',
    ).toBe(41);
    const umMinuto = [true, ...Array<boolean>(19).fill(false)];
    expect(varreduras, 'procurou fora do minuto').toEqual([...umMinuto, ...umMinuto, true]);
  });
});
