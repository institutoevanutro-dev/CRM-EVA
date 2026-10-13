import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';

import { loadActiveRouter, loadRouterById } from './router-config';

function poolSeq(responses: Array<{ rows: unknown[] }>): pg.Pool {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query } as unknown as pg.Pool;
}

describe('loadActiveRouter', () => {
  it('devolve null quando o canal não tem router ativo', async () => {
    const router = await loadActiveRouter(poolSeq([{ rows: [] }]), 'org1', 'cs1');
    expect(router).toBeNull();
  });

  it('monta router com membros ordenados por position', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'Atendimento', config: { classifier_model: 'claude-haiku-4-5', sticky: true, min_confidence: 0.6 }, fallback_agent_id: 'a-fb' }] },
      { rows: [
        { agent_id: 'a2', intent_name: 'suporte', intent_description: 'Problemas técnicos', examples: ['não consigo entrar'] },
        { agent_id: 'a1', intent_name: 'vendas', intent_description: 'Quer comprar', examples: [] },
      ] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.id).toBe('r1');
    expect(router?.classifierModel).toBe('claude-haiku-4-5');
    expect(router?.sticky).toBe(true);
    expect(router?.minConfidence).toBe(0.6);
    expect(router?.fallbackAgentId).toBe('a-fb');
    expect(router?.members.map((m) => m.intentName)).toEqual(['suporte', 'vendas']);
  });

  it('config malformada cai nos defaults (modelo do seam, sticky, 0.6)', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { min_confidence: 'muito' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    // null = "Automático": quem decide é o seam, nunca um id fixo de provedor.
    expect(router?.classifierModel).toBeNull();
    expect(router?.sticky).toBe(true);
    expect(router?.minConfidence).toBe(0.6);
  });
});

describe('loadActiveRouter — provedor do classificador', () => {
  it('lê classifier_provider da config', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { classifier_model: 'gpt-5-mini', classifier_provider: 'openai' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.classifierModel).toBe('gpt-5-mini');
    expect(router?.classifierProvider).toBe('openai');
  });

  it('sem classifier_provider → null (usa o provedor da organização, como antes)', async () => {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config: { classifier_model: 'claude-haiku-4-5' }, fallback_agent_id: null }] },
      { rows: [] },
    ]);
    const router = await loadActiveRouter(pool, 'org1', 'cs1');
    expect(router?.classifierProvider).toBeNull();
  });

  it('classifier_provider vazio ou não-string é ignorado — não vira provedor ""', async () => {
    for (const valor of ['', '   ', 42, null, {}]) {
      const pool = poolSeq([
        { rows: [{ id: 'r1', name: 'X', config: { classifier_provider: valor }, fallback_agent_id: null }] },
        { rows: [] },
      ]);
      const router = await loadActiveRouter(pool, 'org1', 'cs1');
      expect(router?.classifierProvider).toBeNull();
    }
  });
});

describe('loadActiveRouter — modo de permanência', () => {
  async function comConfig(config: unknown) {
    const pool = poolSeq([
      { rows: [{ id: 'r1', name: 'X', config, fallback_agent_id: null }] },
      { rows: [{ agent_id: 'a1', intent_name: 'vendas', intent_description: 'Quer comprar', examples: [] }] },
    ]);
    return loadActiveRouter(pool, 'org1', 'cs1');
  }

  it('sem nada na config: o roteador decide a cada mensagem, como sempre, e nada interrompe', async () => {
    for (const config of [{}, null]) {
      const router = await comConfig(config);
      expect(router?.permanencia).toBe('roteador');
      expect(router?.interrompe).toEqual([]);
    }
  });

  it("permanencia 'agente' força sticky, diga a config o que disser; o modo de sempre obedece à config", async () => {
    // Sem isso a passagem pelo agente seria desfeita na mensagem seguinte.
    expect((await comConfig({ permanencia: 'agente', sticky: false }))?.sticky).toBe(true);
    expect((await comConfig({ permanencia: 'agente' }))?.sticky).toBe(true);
    expect((await comConfig({ sticky: false }))?.sticky).toBe(false);
    expect((await comConfig({ permanencia: 'roteador', sticky: false }))?.sticky).toBe(false);
  });

  it("permanencia 'agente' liga o modo novo; interrompe guarda só strings não vazias", async () => {
    const router = await comConfig({ permanencia: 'agente', interrompe: ['queixa_clinica', 7, ''] });
    expect(router?.permanencia).toBe('agente');
    expect(router?.interrompe).toEqual(['queixa_clinica']);
  });

  it('interrompe é aparado: espaço em volta não impede de casar, e item só de espaço some', async () => {
    const router = await comConfig({ permanencia: 'agente', interrompe: ['queixa_clinica ', '  urgencia', '   '] });
    expect(router?.interrompe).toEqual(['queixa_clinica', 'urgencia']);
  });

  it("valor desconhecido de permanencia cai em 'roteador'", async () => {
    for (const valor of ['qualquer', 'AGENTE', true, 1, null, {}]) {
      expect((await comConfig({ permanencia: valor }))?.permanencia).toBe('roteador');
    }
  });

  it('permanencia_expira_horas: número maior que zero vale; qualquer outra coisa cai em 24', async () => {
    expect((await comConfig({ permanencia: 'agente', permanencia_expira_horas: 6 }))?.permanenciaExpiraHoras).toBe(6);
    expect((await comConfig({ permanencia: 'agente', permanencia_expira_horas: 0.5 }))?.permanenciaExpiraHoras).toBe(0.5);
    for (const valor of [undefined, null, 0, -3, '12', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect((await comConfig({ permanencia: 'agente', permanencia_expira_horas: valor }))?.permanenciaExpiraHoras).toBe(24);
    }
    expect((await comConfig({}))?.permanenciaExpiraHoras).toBe(24);
  });

  it('interrompe que não é array vira lista vazia', async () => {
    for (const valor of ['queixa_clinica', 7, null, { 0: 'queixa_clinica' }]) {
      expect((await comConfig({ permanencia: 'agente', interrompe: valor }))?.interrompe).toEqual([]);
    }
  });

  it('assunto em interrompe que não é membro fica na lista: não quebra, só nunca casa', async () => {
    const router = await comConfig({ permanencia: 'agente', interrompe: ['nao_e_membro'] });
    expect(router?.interrompe).toEqual(['nao_e_membro']);
    expect(router?.members.map((m) => m.intentName)).toEqual(['vendas']);
  });
});

describe('loadRouterById', () => {
  const inativo = { id: 'r1', name: 'Rascunho', config: {}, fallback_agent_id: 'a-fb' };
  const membros = [{ agent_id: 'a1', intent_name: 'vendas', intent_description: 'Quer comprar', examples: null }];

  it('devolve o roteador INATIVO, que loadActiveRouter continua não devolvendo', async () => {
    const pool = poolSeq([{ rows: [inativo] }, { rows: membros }]);
    const router = await loadRouterById(pool, 'org1', 'r1');
    expect(router?.id).toBe('r1');
    expect(router?.fallbackAgentId).toBe('a-fb');
    expect(router?.members).toEqual([
      { agentId: 'a1', intentName: 'vendas', intentDescription: 'Quer comprar', examples: [] },
    ]);

    // A consulta por id filtra organização e id, e NÃO filtra is_active.
    const [sqlPorId, paramsPorId] = vi.mocked(pool.query).mock.calls[0] as unknown as [string, unknown[]];
    expect(sqlPorId).toMatch(/organization_id = \$1/);
    expect(sqlPorId).toMatch(/\bid = \$2/);
    expect(sqlPorId).not.toMatch(/is_active/);
    expect(paramsPorId).toEqual(['org1', 'r1']);

    // loadActiveRouter segue exigindo is_active: o banco não devolve o inativo.
    const poolAtivo = poolSeq([{ rows: [] }]);
    expect(await loadActiveRouter(poolAtivo, 'org1', 'cs1')).toBeNull();
    const [sqlAtivo] = vi.mocked(poolAtivo.query).mock.calls[0] as unknown as [string];
    expect(sqlAtivo).toMatch(/and is_active/);
  });

  it('id de outra organização devolve null e não lê membros', async () => {
    const pool = poolSeq([{ rows: [] }]);
    expect(await loadRouterById(pool, 'org-alheia', 'r1')).toBeNull();
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual(['org-alheia', 'r1']);
  });
});
