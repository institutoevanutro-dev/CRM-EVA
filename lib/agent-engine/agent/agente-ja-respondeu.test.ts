import { expect, it, vi } from 'vitest';

import { agenteJaRespondeuNoAtendimento } from './agente-ja-respondeu';

const alvo = { organizationId: 'org1', conversationId: 'conv1', agentId: 'agente-a' };

it('a régua é uma fala DESTE agente, enviada, no atendimento corrente', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ respondeu: true }] });
  expect(await agenteJaRespondeuNoAtendimento({ query } as never, alvo)).toBe(true);
  const [sql, params] = query.mock.calls[0]!;
  expect(sql).toContain("m.direction = 'outbound'");
  expect(sql).toContain("m.sent_via = 'ai'");
  expect(sql).toContain("m.metadata->>'ai_actor_id' = $3");
  expect(sql).toContain("m.status <> 'failed'");
  expect(sql).toContain('m.sent_at >= c.service_started_at');
  expect(params).toEqual(['org1', 'conv1', 'agente-a']);
});

it('sem linha: não engajado; erro de leitura sobe em vez de virar false', async () => {
  expect(await agenteJaRespondeuNoAtendimento({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never, alvo)).toBe(false);
  await expect(
    agenteJaRespondeuNoAtendimento({ query: vi.fn().mockRejectedValue(new Error('banco fora')) } as never, alvo),
  ).rejects.toThrow('banco fora');
});
