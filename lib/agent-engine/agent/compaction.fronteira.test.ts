import { beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => vi.fn());
const salvar = vi.hoisted(() => vi.fn());
const modelo = vi.hoisted(() => vi.fn());

vi.mock('@/lib/atendimento/fronteira-server', () => ({ guardServiceEffect: guard }));
vi.mock('./lead-notes', () => ({ applySaveLeadNote: salvar }));
vi.mock('../edge/llm/run-model-call', () => ({ runModelCall: modelo }));

import { maybeCompact } from './compaction';

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const chamar = () =>
  maybeCompact(
    {} as never,
    {} as never,
    { tenantId: 't', leadId: 'l' },
    {
      context: { messages: [{}, {}] } as never,
      previousSummary: '',
      knobs: { triggerMessages: 1, transcriptMaxTokens: 100 },
      notesIndexMaxTokens: 100,
    },
    { log: log as never },
  );

describe('flush pré-compaction respeita a fronteira de atendimento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modelo.mockResolvedValue({ result: { text: '{"notes":[{"headline":"h","body":"b"}]}' } });
    salvar.mockResolvedValue({ ok: true });
  });

  it('fronteira vencida (reinício no meio do turno): não grava a nota velha', async () => {
    guard.mockRejectedValue(new Error('service_boundary_stale'));
    await expect(chamar()).rejects.toThrow('service_boundary_stale');
    expect(salvar).not.toHaveBeenCalled();
  });

  it('fronteira vigente: a nota é gravada', async () => {
    guard.mockResolvedValue(undefined);
    await chamar().catch(() => undefined);
    expect(salvar).toHaveBeenCalledTimes(1);
  });
});
