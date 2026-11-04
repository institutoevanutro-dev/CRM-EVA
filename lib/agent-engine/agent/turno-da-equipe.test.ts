import { describe, expect, it, vi } from 'vitest';

const handoff = vi.fn();
const emHandoff = vi.fn();
vi.mock('./human-handoff', () => ({
  performHumanHandoff: (...a: unknown[]) => handoff(...a),
  isLeadInHandoff: (...a: unknown[]) => emHandoff(...a),
}));

import { TITULO_DO_AVISO_DE_ASSUNTO_APOS_EQUIPE, passarTurnoAEquipeSeForOCaso } from './turno-da-equipe';

const ids = { tenantId: 'org-1', leadId: 'contato-1', conversationId: 'conv-1' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('passarTurnoAEquipeSeForOCaso', () => {
  it('bloqueado_apos_equipe: passa à equipe calado, com aviso', async () => {
    handoff.mockReset();
    emHandoff.mockResolvedValue(false);
    expect(await passarTurnoAEquipeSeForOCaso({} as never, ids, { outcome: 'bloqueado_apos_equipe' }, log)).toBe(true);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]![2]).toMatchObject({
      reason: 'assunto_nao_reabre_apos_equipe',
      inboxTitle: TITULO_DO_AVISO_DE_ASSUNTO_APOS_EQUIPE,
    });
  });

  it('já com a equipe: encerra o turno sem reabrir aviso', async () => {
    handoff.mockReset();
    emHandoff.mockResolvedValue(true);
    expect(await passarTurnoAEquipeSeForOCaso({} as never, ids, { outcome: 'bloqueado_apos_equipe' }, log)).toBe(true);
    expect(handoff).not.toHaveBeenCalled();
  });

  it.each(['classified', 'sticky', 'fallback', 'no_router'] as const)('%s: segue o turno normal', async (outcome) => {
    handoff.mockReset();
    expect(await passarTurnoAEquipeSeForOCaso({} as never, ids, { outcome }, log)).toBe(false);
    expect(handoff).not.toHaveBeenCalled();
  });
});
