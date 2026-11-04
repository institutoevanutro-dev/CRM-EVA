/**
 * CONVERSA DE NEGÓCIO E RESPOSTA AUTOMÁTICA: A IA NÃO ESCREVE NADA.
 *
 * Medido no Instituto (02 e 03/11/2026, conversas de fornecedor e de resposta
 * automática de loja): a IA abria o caso e TAMBÉM escrevia — a instrução no
 * prompt não segurava. Com `config.so_equipe` no roteador, o turno de entrada
 * passa à equipe calado, antes de qualquer modelo de atendimento: nenhum
 * `runModelCall`, nenhum envio, UM aviso na Central.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  router: vi.fn(), classify: vi.fn(), byId: vi.fn(), bySession: vi.fn(), inHandoff: vi.fn(), perform: vi.fn(),
  model: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  isLeadInHandoff: mocks.inHandoff, performHumanHandoff: mocks.perform,
}));
vi.mock('@/lib/agent-engine/edge/llm/run-model-call', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runModelCall: mocks.model,
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import { TITULO_DO_AVISO_SO_DA_EQUIPE } from '@/lib/agent-engine/agent/turno-da-equipe';

const AGORA = new Date('2026-11-03T17:00:00.000Z');
const ids = {
  org: '13000000-0000-4000-8000-000000000001', contact: '13000000-0000-4000-8000-000000000002',
  conversation: '13000000-0000-4000-8000-000000000003', channel: '13000000-0000-4000-8000-000000000004',
};
const job = {
  id: '13000000-0000-4000-8000-000000000005', organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '13000000-0000-4000-8000-000000000006', crm_event_id: '13000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {}, clock: () => AGORA,
} as unknown as InboundTurnDeps;

const roteador = (soEquipe: boolean) => ({
  id: 'r1', name: 'R', classifierModel: null, classifierProvider: null, sticky: true, minConfidence: 0.8,
  permanencia: 'agente', interrompe: ['queixa'], permanenciaExpiraHoras: 24, fallbackAgentId: 'agent-recepcao',
  naoReabreAposEquipe: [], soEquipe,
  members: [{ agentId: 'agent-recepcao', intentName: 'recepcao', intentDescription: 'geral', examples: [] }],
});

/** Banco: a última mensagem do contato, conversa sem saída nossa, agenda vazia. */
function pool(texto: string) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/select body,type,media_url/.test(sql)) {
        return { rows: [{ body: texto, type: 'text', media_url: null, media_storage_path: null, media_derived_text: null }] };
      }
      if (/as equipe_falou/.test(sql)) {
        return { rows: [{ active_ai_agent_id: null, active_intent: null, active_agent_set_at: null, equipe_falou: false, sem_saida: false }] };
      }
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inHandoff.mockResolvedValue(false);
  mocks.model.mockRejectedValue(new Error('chegou_no_modelo'));
  // O agente de atendimento "explode": carregá-lo prova que o turno seguiu.
  mocks.byId.mockRejectedValue(new Error('chegou_no_agente'));
});

describe('turno de entrada com config.so_equipe', () => {
  it('⭐ fornecedor (0,95, sem agenda): passa à equipe calado, com aviso, sem modelo de atendimento', async () => {
    mocks.router.mockResolvedValue(roteador(true));
    mocks.classify.mockResolvedValue({ intentName: 'negocio_com_a_empresa', confidence: 0.95 });
    const p = pool('Boa tarde, sou representante de uma distribuidora e gostaria de apresentar nosso catálogo');
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'w' });
    expect(mocks.perform).toHaveBeenCalledOnce();
    expect(mocks.perform).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'assunto_da_equipe', inboxTitle: TITULO_DO_AVISO_SO_DA_EQUIPE }),
    );
    expect(mocks.byId).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    // Nenhum envio: nada foi gravado em `messages`.
    expect(p.query.mock.calls.some(([sql]) => /insert into messages/i.test(String(sql)))).toBe(false);
  });

  it('controle: sem a flag, o mesmo veredito segue para o agente de atendimento', async () => {
    mocks.router.mockResolvedValue(roteador(false));
    mocks.classify.mockResolvedValue({ intentName: 'negocio_com_a_empresa', confidence: 0.95 });
    await expect(
      createInboundTurnHandler(deps)(job as never, pool('Proposta de parceria') as never, { workerId: 'w' }),
    ).rejects.toThrow();
    expect(mocks.perform).not.toHaveBeenCalled();
    expect(mocks.byId).toHaveBeenCalled();
  });
});
