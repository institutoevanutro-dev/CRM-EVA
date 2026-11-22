import { expect, it, vi } from 'vitest';

import { PACING_DEFAULTS } from './defaults';

const janela = vi.hoisted(() => ({ aberta: true }));
vi.mock('./store', () => ({
  loadChannelKnobs: async () => ({
    knobs: { ...PACING_DEFAULTS, allowSunday: true, respostaStartHour: 0, respostaEndHour: janela.aberta ? 24 : 0 },
    numberActivatedAt: null,
  }),
}));

import { adiadoPelaJanelaDeResposta, adiadoPorJanela, soltarAdiadosDaSessao } from './adiados-da-janela';

const alvo = { organizationId: 'org1', channelSessionId: 'cs1' };

it('o rastro só vale para a janela de resposta', () => {
  expect(adiadoPelaJanelaDeResposta(adiadoPorJanela({ tipo: 'resposta', abertura: 'x', janela: '7h-22h' }))).toBe(true);
  expect(adiadoPelaJanelaDeResposta(adiadoPorJanela({ tipo: 'disparo', abertura: 'x', janela: '7h-22h' }))).toBe(false);
  expect(adiadoPelaJanelaDeResposta({})).toBe(false);
  expect(adiadoPelaJanelaDeResposta(null)).toBe(false);
});

it('janela aberta: acorda só pendente-futuro com o rastro, da conexão, sem insert', async () => {
  janela.aberta = true;
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 2 });
  expect(await soltarAdiadosDaSessao({ query } as never, alvo)).toBe(2);
  const [sql, params] = query.mock.calls[0]!;
  expect(sql).toContain('set run_after = now()');
  expect(sql).toContain('run_after > now()');
  expect(sql).toContain("not (payload ? 'held_run_after')");
  expect(sql).not.toContain('insert');
  expect(params).toEqual(['org1', 'cs1']);
});

it('janela fechada: ninguém mexe', async () => {
  janela.aberta = false;
  const query = vi.fn();
  expect(await soltarAdiadosDaSessao({ query } as never, alvo)).toBe(0);
  expect(query).not.toHaveBeenCalled();
});
