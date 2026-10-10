/**
 * Continuação do #2506 (porte de melgarafael/DeskcommCRM#2652): os call sites
 * RESTANTES de `connect()` com transação aberta à mão também devolviam o
 * cliente ao pool sem erro quando algo falhava lá dentro.
 *
 * Neste fork são seis: os dois que o upstream também tem (aviso-caso-obsoleto e
 * health/circuit) e quatro só daqui (agenda/importar-historico, campanhas/rodada,
 * supervisao/acionamento e supervisao/db-pg).
 *
 * Duas réguas:
 *   1. comportamento, com cliente FALSO, em quatro deles: consulta que rejeita
 *      dentro da transação → `release` COM erro; caminho feliz → `release` SEM erro;
 *   2. varredura do código: todo arquivo de `app/`, `lib/` e `workers/` que abre transação à
 *      mão tem um `release(<erro>)` para cada `connect()`. É ela que cobre
 *      campanhas/rodada e supervisao/acionamento, e o próximo call site que nascer.
 *
 * O que NÃO é medido aqui: o descarte real do socket. Isso é a semântica do
 * próprio pg-pool (`release(err)` remove o cliente em vez de reemprestá-lo).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CasosDeHumano from '@/lib/agent-engine/agent/human-cases';
import { resolveCaseFromHuman } from '@/lib/agent-engine/agent/human-cases';
import { channelHealthTick } from '@/lib/agent-engine/health/circuit';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import { importarHistorico } from '@/lib/agenda/importar-historico';
import { registrarRespostaDeCasoObsoleto } from '@/lib/atendimento/aviso-caso-obsoleto';
import { createPgSupervisaoDb } from '@/lib/supervisao/db-pg';
import type { SupervisaoDb } from '@/lib/supervisao/executor';

vi.mock('@/lib/agent-engine/agent/human-cases', async (importOriginal) => ({
  ...(await importOriginal<typeof CasosDeHumano>()),
  resolveCaseFromHuman: vi.fn(),
}));

const MENSAGEM = 'Query read timeout';
const ORG = '10000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const CANAL = '30000000-0000-4000-8000-000000000001';

interface ClienteFalso {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

/** `query` rejeita em `falhaEm` (substring minúscula do SQL); `release` é espio. */
function clienteFalso(falhaEm?: string): ClienteFalso {
  return {
    query: vi.fn(async (sql: string) => {
      if (falhaEm !== undefined && String(sql).toLowerCase().includes(falhaEm)) throw new Error(MENSAGEM);
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
}

function poolFalso(cliente: ClienteFalso): pg.Pool {
  return {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as pg.Pool;
}

function liberouComErro(cliente: ClienteFalso): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  const liberado = cliente.release.mock.calls[0]?.[0];
  expect(liberado, 'o cliente voltou ao pool SEM erro').toBeInstanceOf(Error);
  expect((liberado as Error).message).toBe(MENSAGEM);
}

function liberouSemErro(cliente: ClienteFalso): void {
  expect(cliente.release, 'release deveria ser chamado UMA vez').toHaveBeenCalledTimes(1);
  expect(cliente.release.mock.calls[0]?.[0]).toBeUndefined();
}

function comandos(cliente: ClienteFalso): string[] {
  return cliente.query.mock.calls.map(([sql]) => String(sql).toLowerCase().trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aviso-caso-obsoleto.ts (registrarRespostaDeCasoObsoleto)', () => {
  it('a resolução que rejeita solta o cliente COM erro e o erro sobe', async () => {
    const cliente = clienteFalso();
    vi.mocked(resolveCaseFromHuman).mockRejectedValueOnce(new Error(MENSAGEM));

    await expect(
      registrarRespostaDeCasoObsoleto(poolFalso(cliente), ORG, CASE_ID, USER_ID, 'respondido'),
    ).rejects.toThrow(MENSAGEM);

    expect(comandos(cliente)).toEqual(['begin', 'rollback']);
    liberouComErro(cliente);
  });

  it('caminho feliz (caso já resolvido por outro) solta o cliente SEM erro', async () => {
    const cliente = clienteFalso();
    vi.mocked(resolveCaseFromHuman).mockResolvedValueOnce(false);

    await expect(
      registrarRespostaDeCasoObsoleto(poolFalso(cliente), ORG, CASE_ID, USER_ID, 'respondido'),
    ).resolves.toBe(false);

    liberouSemErro(cliente);
  });
});

describe('health/circuit.ts (evaluateSession via channelHealthTick)', () => {
  it('o select com for update que rejeita solta o cliente COM erro', async () => {
    const LOG: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const cliente = clienteFalso('for update');
    const pool = {
      connect: vi.fn(async () => cliente),
      // espelho, knobs e taxas: tudo no pool; a transação da sessão é do cliente.
      query: vi.fn(async (sql: string) => {
        const s = String(sql).toLowerCase();
        if (s.includes('health_knobs') || s.includes('with cut')) return { rows: [], rowCount: 0 };
        if (s.includes('channel_session_health'))
          return { rows: [{ organization_id: ORG, channel_session_id: CANAL }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as pg.Pool;

    // a sessão que falhou não derruba as demais: o tick segue e loga o erro.
    const tick = await channelHealthTick(pool, LOG);

    expect(tick.evaluated).toBe(0);
    expect(LOG.error).toHaveBeenCalled();
    expect(comandos(cliente)).toEqual(['begin', expect.stringContaining('for update'), 'rollback']);
    liberouComErro(cliente);
  });
});

describe('agenda/importar-historico.ts (importarHistorico)', () => {
  it('a consulta que rejeita dentro da transação solta o cliente COM erro', async () => {
    const cliente = clienteFalso('lock_timeout');
    const entrada = {
      organization_id: ORG,
      owner_user_id: USER_ID,
      actor_user_id: USER_ID,
      rows: [
        {
          key: 'a'.repeat(64),
          contact_id: CASE_ID,
          title: 'Consulta',
          starts_at: '2026-01-05T13:00:00.000Z',
          ends_at: '2026-01-05T14:00:00.000Z',
          status: 'completed',
        },
      ],
    };

    await expect(importarHistorico(poolFalso(cliente), entrada)).rejects.toThrow(MENSAGEM);

    expect(comandos(cliente)).toEqual(['begin', expect.stringContaining('lock_timeout'), 'rollback']);
    liberouComErro(cliente);
  });
});

describe('supervisao/db-pg.ts (moverEtapaComTrava)', () => {
  it('a leitura que rejeita dentro da transação solta o cliente COM erro', async () => {
    const cliente = clienteFalso('from crm_lead_activities');
    const db = createPgSupervisaoDb(poolFalso(cliente));
    const input = {
      organization_id: ORG,
      lead_id: CASE_ID,
      action_key: 'chave',
    } as Parameters<SupervisaoDb['moverEtapaComTrava']>[0];

    await expect(db.moverEtapaComTrava(input)).rejects.toThrow(MENSAGEM);

    expect(comandos(cliente)).toContain('rollback');
    liberouComErro(cliente);
  });
});

describe('varredura: transação aberta à mão libera COM erro quem falhou', () => {
  const RAIZ = process.cwd();
  const arquivos = ['app', 'lib', 'workers'].flatMap((dir) =>
    (readdirSync(join(RAIZ, dir), { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join(dir, f)),
  );
  const comTransacao = arquivos
    .map((arquivo) => ({ arquivo, fonte: readFileSync(join(RAIZ, arquivo), 'utf8') }))
    .filter(({ fonte }) => /\.connect\(\)/.test(fonte) && /query\(\s*['"`]begin/i.test(fonte));

  it('acha os call sites (a varredura não está cega)', () => {
    expect(comTransacao.map((c) => c.arquivo)).toEqual(
      expect.arrayContaining(['lib/campanhas/rodada.ts', 'lib/supervisao/acionamento.ts']),
    );
  });

  it.each(comTransacao)('$arquivo tem um release(<erro>) para cada connect()', ({ fonte }) => {
    const conexoes = fonte.match(/\.connect\(\)/g)?.length ?? 0;
    const comErro = fonte.match(/\.release\([^)\s]/g)?.length ?? 0;
    expect(comErro).toBeGreaterThanOrEqual(conexoes);
  });
});
