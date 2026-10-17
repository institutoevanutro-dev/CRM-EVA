/**
 * Robô do outro lado: o laço bot-com-bot do incidente de 16/10/2026 (37 envios
 * da IA em 7 min para um chatbot que repetia o mesmo texto) para ANTES do
 * roteador e do modelo. Ver `lib/agent-engine/agent/robo-do-outro-lado.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectarRoboDoOutroLado,
  ROBO_KNOBS_PADRAO,
  TITULO_DO_AVISO_DE_ROBO,
  type MensagemRecente,
} from '@/lib/agent-engine/agent/robo-do-outro-lado';

const AGORA = new Date('2026-10-16T11:13:00.000Z');
const BAYER =
  'Ops, não consegui entender a sua resposta! Por enquanto, não sou capaz de efetuar atendimento para outros assuntos.';
const min = (n: number) => new Date(AGORA.getTime() - n * 60_000);
const entra = (body: string, minutosAtras: number): MensagemRecente => ({
  direction: 'inbound', sent_via: 'crm', body, sent_at: min(minutosAtras),
});
const sai = (sentVia: string, minutosAtras: number): MensagemRecente => ({
  direction: 'outbound', sent_via: sentVia, body: 'Olá! Posso ajudar com o seu agendamento?', sent_at: min(minutosAtras),
});

describe('detectarRoboDoOutroLado — assinatura A (mesma mensagem repetida)', () => {
  it('⭐ o incidente: o texto do chatbot 3x em poucos minutos → robô', () => {
    const msgs = [entra(BAYER, 4), sai('ai', 3.9), entra(BAYER, 3), sai('ai', 2.9), entra(BAYER, 1)];
    expect(detectarRoboDoOutroLado(msgs, AGORA)).toEqual({ robo: true, sinal: 'inbound_repetido', contagem: 3 });
  });

  it('quase idêntico (uma palavra a mais) também conta', () => {
    const msgs = [entra(BAYER, 4), entra(BAYER, 3), entra(`${BAYER} Obrigado.`, 1)];
    expect(detectarRoboDoOutroLado(msgs, AGORA).robo).toBe(true);
  });

  it('pessoa que repete "oi" — duas, ou até quatro vezes — NÃO é robô', () => {
    expect(detectarRoboDoOutroLado([entra('oi', 2), entra('oi', 1)], AGORA).robo).toBe(false);
    expect(detectarRoboDoOutroLado([entra('oi', 4), entra('oi', 3), entra('Oi', 2), entra('oi!', 1)], AGORA).robo).toBe(false);
  });

  it('pessoa que reenvia a mesma pergunta longa DUAS vezes não é robô', () => {
    expect(detectarRoboDoOutroLado([entra(BAYER, 3), entra(BAYER, 1)], AGORA).robo).toBe(false);
  });

  it('cópias fora da janela de 10 min não contam', () => {
    expect(detectarRoboDoOutroLado([entra(BAYER, 30), entra(BAYER, 20), entra(BAYER, 1)], AGORA).robo).toBe(false);
  });

  it('a última recebida é diferente → o laço acabou, não dispara', () => {
    const msgs = [entra(BAYER, 5), entra(BAYER, 4), entra(BAYER, 3), entra('Quero marcar consulta para terça de manhã', 1)];
    expect(detectarRoboDoOutroLado(msgs, AGORA).robo).toBe(false);
  });
});

describe('detectarRoboDoOutroLado — assinatura B (rajada da IA sem pessoa)', () => {
  const rajada = (n: number) => Array.from({ length: n }, (_, i) => sai('ai', (i * 4.5) / n));
  it('mais de 20 envios da IA em 5 min, nenhum humano → robô', () => {
    expect(detectarRoboDoOutroLado(rajada(21), AGORA)).toEqual({ robo: true, sinal: 'rajada_da_ia', contagem: 21 });
  });
  it('exatamente 20 não dispara (o teto é "mais de")', () => {
    expect(detectarRoboDoOutroLado(rajada(20), AGORA).robo).toBe(false);
  });
  it('conversa rápida e real (7 trocas com até 2 bolhas cada) não dispara', () => {
    expect(detectarRoboDoOutroLado(rajada(14), AGORA).robo).toBe(false);
  });
  it('uma pessoa da equipe falou na janela → não é laço de robô', () => {
    expect(detectarRoboDoOutroLado([...rajada(25), sai('crm', 1)], AGORA).robo).toBe(false);
  });
});

// ── a fiação: o handler de inbound para ANTES do roteador ───────────────────

const mocks = vi.hoisted(() => ({
  router: vi.fn(), byId: vi.fn(), bySession: vi.fn(), conversationAgent: vi.fn(),
  inHandoff: vi.fn(), perform: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: vi.fn() }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadPublishedAgentConfigById: mocks.byId, loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  isLeadInHandoff: mocks.inHandoff, performHumanHandoff: mocks.perform,
}));

import { createInboundTurnHandler, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';

const ids = {
  org: '12000000-0000-4000-8000-000000000001', contact: '12000000-0000-4000-8000-000000000002',
  conversation: '12000000-0000-4000-8000-000000000003', channel: '12000000-0000-4000-8000-000000000004',
};
const job = {
  id: '12000000-0000-4000-8000-000000000005', organization_id: ids.org, contact_id: ids.contact, kind: 'inbound_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact, channel_session_id: ids.channel,
    inbound_message_id: '12000000-0000-4000-8000-000000000006', crm_event_id: '12000000-0000-4000-8000-000000000007' },
};
const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {}, crmCfg: {}, knobs: {}, clock: () => AGORA,
} as unknown as InboundTurnDeps;

function pool(janela: MensagemRecente[]) {
  const query = vi.fn(async (sql: string) => {
    if (/from messages m\s+join conversations c/.test(sql)) return { rows: janela };
    return { rows: [] };
  });
  return { query };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inHandoff.mockResolvedValue(false);
  // O roteador "explode" de propósito: chegar nele prova que o disjuntor deixou passar.
  mocks.router.mockRejectedValue(new Error('chegou_no_roteador'));
});

describe('createInboundTurnHandler — disjuntor antes do modelo', () => {
  const laco = [entra(BAYER, 4), sai('ai', 3.9), entra(BAYER, 3), sai('ai', 2.9), entra(BAYER, 1)];

  it('⭐ laço com robô → silencia pelo handoff, UM aviso, e o roteador nem é consultado', async () => {
    const p = pool(laco);
    await createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'w' });
    expect(mocks.router).not.toHaveBeenCalled();
    expect(mocks.perform).toHaveBeenCalledOnce();
    expect(mocks.perform).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'suspected_bot_loop', inboxTitle: TITULO_DO_AVISO_DE_ROBO }),
    );
    const [sql, params] = p.query.mock.calls.find(([s]) => /from messages m/.test(String(s))) as unknown as [string, unknown[]];
    expect(sql).toMatch(/m\.organization_id = \$1/);
    expect(params[0]).toBe(ids.org);
  });

  it('já em handoff → não reabre aviso, e o turno segue calado', async () => {
    mocks.inHandoff.mockResolvedValue(true);
    await createInboundTurnHandler(deps)(job as never, pool(laco) as never, { workerId: 'w' });
    expect(mocks.perform).not.toHaveBeenCalled();
    expect(mocks.router).not.toHaveBeenCalled();
  });

  it('controle: conversa normal → nada de handoff, o turno chega ao roteador', async () => {
    const p = pool([entra('oi', 2), sai('ai', 1.5), entra('oi', 1)]);
    await expect(createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'w' })).rejects.toThrow();
    expect(mocks.perform).not.toHaveBeenCalled();
    expect(mocks.router).toHaveBeenCalled();
  });

  it('leitura da janela quebrada degrada ABERTO (o turno segue)', async () => {
    const p = { query: vi.fn(async (sql: string) => {
      if (/from messages m/.test(sql)) throw new Error('connection terminated');
      return { rows: [] };
    }) };
    await expect(createInboundTurnHandler(deps)(job as never, p as never, { workerId: 'w' })).rejects.toThrow();
    expect(mocks.perform).not.toHaveBeenCalled();
    expect(mocks.router).toHaveBeenCalled();
  });
});

it('defaults documentados', () => {
  expect(ROBO_KNOBS_PADRAO).toEqual({ repeticoes: 3, janelaRepeticaoMs: 600_000, rajadaIaMax: 20, janelaRajadaMs: 300_000 });
});
