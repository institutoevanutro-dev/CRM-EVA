/**
 * "Sempre atendimento humano" (`contacts.force_human`, que `ai_opt_out` mantém
 * ligado) cala SÓ A IA — decisão do dono, 18-19/10/2026.
 *
 * O defeito: uma inscrição da sequência pós-consulta (mensagens FIXAS de
 * 7/15/30/45/75 dias) foi encerrada com "uma pessoa da equipe está atendendo
 * esta conversa", com `handoff_policy='allow'`, só porque o contato tinha a
 * marca. O `force_human` barrava o passo fixo em QUATRO portas, e consertar só
 * a primeira (`decidirEnvio`, coberto em `bloqueios-obrigatorios.test.ts`)
 * deixava as outras recusando:
 *
 *   1. a pessoa no comando do turno (`isLeadInHandoff`);
 *   2. o topo de `sendFixedOutbound` (`isLeadInHandoff` de novo);
 *   3. o gate `stop` da cadeia (`readStopFlags`: `is_blocked or force_human`);
 *   4. o envio bolha a bolha (`pessoaNoComandoDaConversa`).
 *
 * Aqui se prende o caminho inteiro do worker, e as portas 3 e 4 de perto. A IA
 * continua calada: passo de IA é PULADO e o fluxo segue.
 */
import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FollowupTurnModule from '@/lib/agent-engine/agent/followup-turn';
import type * as InboundTurnModule from '@/lib/agent-engine/agent/inbound-turn';
import type * as SendMessageModule from '@/lib/agent-engine/edge/crm/send-message';
import type * as BeforeSendModule from '@/lib/agent-engine/guardrails/before-send';
import type { JobRow } from '@/lib/agent-engine/queue/queue';
import { pessoaNoComandoDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import { TEXTO_DO_BLOQUEIO, TEXTO_DO_PULO } from '@/lib/followup/bloqueios-obrigatorios';

// A cadeia é simulada no teste do worker (o gate `stop` real é medido abaixo),
// mas CHAMA o `send` de verdade e guarda os argumentos.
const cadeiaFalsa = vi.fn(async (args: Record<string, unknown>): Promise<Record<string, unknown>> => ({
  status: 'sent',
  outcome: await (args.send as (b: string) => Promise<unknown>)(args.body as string),
  trace: [],
}));
vi.mock('@/lib/agent-engine/guardrails/before-send', async (original) => {
  const real = await original<typeof BeforeSendModule>();
  return { ...real, runBeforeSend: (a: Record<string, unknown>) => cadeiaFalsa(a) };
});
vi.mock('@/lib/agent-engine/edge/crm/get-lead-context', () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock('@/lib/agent-engine/edge/crm/send-message', async (original) => ({
  ...(await original<typeof SendMessageModule>()),
  applySendOutcome: vi.fn(async () => undefined),
}));
const runAgentTurn = vi.fn(async () => undefined);
vi.mock('@/lib/agent-engine/agent/inbound-turn', async (original) => {
  const real = await original<typeof InboundTurnModule>();
  return { ...real, runAgentTurn };
});

const ORG = 'org-1';
const LEAD = 'lead-1';
const CONVERSA = 'conversa-1';
const ENR = '11111111-1111-4111-8111-111111111111';
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

function job(payload: Record<string, unknown>): JobRow {
  return {
    id: 'job-1', organization_id: ORG, contact_id: LEAD, kind: 'followup_turn', source_event_id: null,
    payload: { followup_enrollment_id: ENR, node_id: 'node-1', purpose: 'send_message', ...payload, service_boundary: boundary },
    status: 'running', priority: 0, run_after: new Date(), attempts: 1, max_attempts: 3, last_error: null,
    locked_by: 'w1', locked_at: new Date(), created_at: new Date(),
  } as JobRow;
}

interface Estado {
  force_human: boolean;
  is_blocked?: boolean;
  bot_silenciado?: boolean;
  handoff_policy?: 'pause' | 'cancel' | 'allow';
}

/** Pool que responde como o Postgres. `isLeadInHandoff` é o real: lê o SQL que ele monta. */
function fakePool(e: Estado) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes('d.fechada_em::text')) return { rows: [{ ...boundary, status: 'open', demanda_fechada_em: null }] };
    if (/from send_ledger l/.test(sql)) return { rows: [{ status: 'accepted', error_code: null }] };
    if (sql.includes('as handoff')) {
      // `c.force_human` só entra no SQL quando a trava do contato conta.
      return { rows: [{ handoff: (sql.includes('c.force_human') && e.force_human) || e.bot_silenciado === true }] };
    }
    if (sql.includes('select current_node_id, status from followup_enrollments')) return { rows: [{ current_node_id: 'node-1', status: 'active' }], rowCount: 1 };
    if (sql.includes('e.status, e.current_node_id, e.steps_taken, p.handoff_policy')) {
      return { rows: [{ status: 'active', current_node_id: 'node-1', steps_taken: 3, handoff_policy: e.handoff_policy ?? 'pause', fim_do_silencio_ms: null }] };
    }
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: 'canal-1', archived_at: null, bot_silenciado: e.bot_silenciado === true,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(Date.now() - 3_600_000),
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: 'active', started_at: new Date(0), pointer_id: '22222222-2222-4222-8222-222222222222',
        trigger_config: null, handoff_policy: e.handoff_policy ?? 'pause', appointment_id: null,
        reserva_criada_em: null, reserva_consulta_em: null, reserva_sujeita_a_sinal: null,
      }] };
    }
    if (/from contacts/.test(sql)) {
      return { rows: [{ name: 'Maria Souza', display_name: 'Maria Souza', is_blocked: e.is_blocked === true, force_human: e.force_human, is_anonymized: false, oculto: false }] };
    }
    if (/from organizations/.test(sql)) return { rows: [{ settings: {} }] };
    return { rows: [], rowCount: 0 };
  });
  return { query } as never;
}

function deps() {
  const complete = vi.fn(async (..._a: unknown[]) => undefined);
  const send = vi.fn(async (..._a: unknown[]) => ({ kind: 'sent' }));
  return {
    complete,
    send,
    deps: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      crmCfg: {}, llmCfg: {}, knobs: {},
      channel: () => ({ send }),
      completeFollowupTurn: complete,
    } as never,
  };
}

const ctx = { workerId: 'w1' };
let criarHandler: typeof FollowupTurnModule.createFollowupTurnHandler;
let runBeforeSendReal: typeof BeforeSendModule.runBeforeSend;
let BEFORE_SEND_GATES: typeof BeforeSendModule.BEFORE_SEND_GATES;
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import('@/lib/agent-engine/agent/followup-turn'));
  const real = await vi.importActual<typeof BeforeSendModule>('@/lib/agent-engine/guardrails/before-send');
  runBeforeSendReal = real.runBeforeSend;
  BEFORE_SEND_GATES = real.BEFORE_SEND_GATES;
}, 60_000);
beforeEach(() => {
  cadeiaFalsa.mockClear();
  runAgentTurn.mockClear();
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;

describe("worker: passo de fluxo para quem é 'sempre atendimento humano'", () => {
  for (const handoff_policy of ['pause', 'cancel', 'allow'] as const) {
    it(`${handoff_policy}: o texto fixo SAI, e a cadeia é avisada de que é passo fixo`, async () => {
      const d = deps();
      await criarHandler(d.deps)(job({ fixed_body: 'Oi {{primeiro_nome}}, como está a pele?' }), fakePool({ force_human: true, handoff_policy }), ctx);
      expect(d.send).toHaveBeenCalledTimes(1);
      expect(d.send.mock.calls[0]![0]).toMatchObject({ body: 'Oi Maria, como está a pele?' });
      expect((cadeiaFalsa.mock.calls[0]![0] as { passoFixoDoFluxo?: boolean }).passoFixoDoFluxo).toBe(true);
      expect(resultado(d.complete)).toEqual({ kind: 'sent' });
      expect(runAgentTurn).not.toHaveBeenCalled();
    });

    it(`${handoff_policy}: o passo de IA é PULADO (o fluxo segue), sem chamar o modelo`, async () => {
      const d = deps();
      await criarHandler(d.deps)(job({ prompt_hint: 'retome a conversa' }), fakePool({ force_human: true, handoff_policy }), ctx);
      expect(runAgentTurn).not.toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
      expect(resultado(d.complete)).toEqual({ kind: 'pulado', reason: TEXTO_DO_PULO.atendimento_humano });
    });
  }

  it('controle: STOP (is_blocked) encerra o passo fixo com opt-out', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: 'Oi' }), fakePool({ force_human: true, is_blocked: true, handoff_policy: 'allow' }), ctx);
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: 'skipped', reason: TEXTO_DO_BLOQUEIO.opt_out, outcome: 'opted_out' });
  });

  it('controle: bot silenciado (handoff de verdade) encerra o passo fixo, mesmo com allow', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: 'Oi' }), fakePool({ force_human: true, bot_silenciado: true, handoff_policy: 'allow' }), ctx);
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: 'skipped', reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome: 'handoff' });
  });
});

describe('gate stop da cadeia: só solta o force_human para o passo fixo confirmado no job', () => {
  function poolDaCadeia(contato: { is_blocked: boolean; force_human: boolean }, jobPayload: Record<string, unknown> | null) {
    const client = {
      query: vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
        if (sql.includes('from job_queue')) {
          return { rows: jobPayload === null ? [] : [{ kind: 'followup_turn', payload: jobPayload }] };
        }
        if (sql.includes('from contacts')) {
          const stopped = sql.includes('force_human') ? contato.is_blocked || contato.force_human : contato.is_blocked;
          return { rows: [{ is_blocked: contato.is_blocked, stopped }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    return { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [{ id: 'trace-1' }] })) } as unknown as pg.Pool;
  }
  const FIXO = { followup_enrollment_id: ENR, purpose: 'send_message', fixed_body: 'Oi' };
  const IA = { followup_enrollment_id: ENR, purpose: 'send_message', prompt_hint: 'x' };
  const rodar = (pool: pg.Pool, extras: Partial<BeforeSendModule.RunBeforeSendArgs> = {}) =>
    runBeforeSendReal({
      pool,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tenantId: ORG, leadId: LEAD, jobId: 'job-1', channelSessionId: 'canal-1',
      body: 'Oi', optedOutThisTurn: false, crmDailyLimit: null, now: new Date('2026-10-19T12:00:00.000Z'),
      rng: () => 0, sleep: async () => {},
      gates: [BEFORE_SEND_GATES[0]!],
      send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
      ...extras,
    } as BeforeSendModule.RunBeforeSendArgs);
  const SEMPRE_HUMANO = { is_blocked: false, force_human: true };

  it('passo fixo confirmado no job: passa', async () => {
    expect((await rodar(poolDaCadeia(SEMPRE_HUMANO, FIXO), { passoFixoDoFluxo: true })).status).toBe('sent');
  });
  it('o aviso sozinho não solta: job de passo de IA veta', async () => {
    expect(await rodar(poolDaCadeia(SEMPRE_HUMANO, IA), { passoFixoDoFluxo: true })).toMatchObject({ status: 'vetoed', code: 'conversa_com_humano' });
  });
  it('sem o aviso, nada muda: veta', async () => {
    expect(await rodar(poolDaCadeia(SEMPRE_HUMANO, FIXO))).toMatchObject({ status: 'vetoed', code: 'conversa_com_humano' });
  });
  it('STOP para o passo fixo confirmado', async () => {
    expect(await rodar(poolDaCadeia({ is_blocked: true, force_human: true }, FIXO), { passoFixoDoFluxo: true })).toMatchObject({ status: 'vetoed', code: 'contato_bloqueado' });
  });
});

describe('envio bolha a bolha (`pessoaNoComandoDaConversa`)', () => {
  const linha = (over: Record<string, unknown>) => ({
    query: vi.fn(async () => ({
      rows: [{ contato_oculto: false, channel_metadata: {}, force_human: true, assignee_kind: null, bot_silenced_until: null, ai_authorized_at: null, phone_number: '+5585987654321', provider: DEFAULT_CHANNEL_PROVIDER, ...over }],
    })),
  }) as never;
  const alvo = { organizationId: ORG, conversationId: CONVERSA };

  it('force_human barra a IA, e não barra o passo fixo', async () => {
    expect(await pessoaNoComandoDaConversa(linha({}), alvo, 'followup_turn')).not.toBeNull();
    expect(await pessoaNoComandoDaConversa(linha({}), alvo, 'followup_turn', { ignorarTravaDoContato: true })).toBeNull();
  });
  it('silêncio em vigor barra os dois', async () => {
    const silenciada = linha({ bot_silenced_until: 'infinity' });
    expect(await pessoaNoComandoDaConversa(silenciada, alvo, 'followup_turn', { ignorarTravaDoContato: true })).not.toBeNull();
  });
});
