/**
 * Pós-consulta continua com a IA pausada — só as mensagens FIXAS (decisão do
 * dono, 21/10/2026).
 *
 * O defeito: o fluxo "DR. ANDRÉ | Pós-consulta" (gatilho `appointment_attended`,
 * `handoff_policy='allow'`, `cancel_on_reply=false`) acabava inteiro com
 * "uma pessoa da equipe está atendendo esta conversa" assim que a IA estava
 * pausada na conversa — o `infinity` do handoff da IA ou do "Assumir", ou a
 * pausa depois da resposta de uma pessoa. As mensagens de 7/15/30/45/75 dias
 * nunca saíam.
 *
 * A regra (`fixasIgnoramAPausaDaIA`): gatilho de CONSULTA + `allow`. Aí a
 * pausa cala só a IA — passo fixo sai, passo de IA é pulado e o fluxo segue.
 * Follow-up de lead (silêncio, etapa, manual…) continua acabando quando uma
 * pessoa assume, e `pause`/`cancel` continuam adiando/encerrando.
 *
 * A pausa barrava o passo fixo em TRÊS portas; aqui se prende cada uma:
 *   1. `decidirEnvio` (matriz abaixo);
 *   2. o topo de `sendFixedOutbound` (`isLeadInHandoff`) — caminho do worker;
 *   3. o envio bolha a bolha (`pessoaNoComandoDaConversa` via `sendTurnMessage`).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as FollowupTurnModule from '@/lib/agent-engine/agent/followup-turn';
import type * as InboundTurnModule from '@/lib/agent-engine/agent/inbound-turn';
import type * as SendMessageModule from '@/lib/agent-engine/edge/crm/send-message';
import type * as BeforeSendModule from '@/lib/agent-engine/guardrails/before-send';
import type { JobRow } from '@/lib/agent-engine/queue/queue';
import { pessoaNoComandoDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';
import {
  CONFIG_SEM_BLOQUEIOS_OPCIONAIS,
  TEXTO_DO_BLOQUEIO,
  TEXTO_DO_PULO,
  decidirEnvio,
  fixasIgnoramAPausaDaIA,
  passoFixoIgnoraPausaDaIA,
  type FatosDoEnvio,
} from '@/lib/followup/bloqueios-obrigatorios';

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

const CANAL_DO_MEDICO = 'c1111111-1111-4111-8111-111111111111';
const ETAPA = 'a0000000-0000-4000-8000-000000000004';
const GATILHOS = {
  appointment_attended: { kind: 'appointment_attended', params: { channel_session_id: CANAL_DO_MEDICO }, cancel_on_reply: false },
  appointment_no_show: { kind: 'appointment_no_show', cancel_on_reply: false },
  silence: { kind: 'silence', params: { threshold_minutes: 60 } },
  stage_change: { kind: 'stage_change', params: { stage_id: ETAPA } },
  manual: { kind: 'manual' },
  webhook: { kind: 'webhook' },
  case_opened: { kind: 'case_opened' },
  conversation_end: { kind: 'conversation_end', params: {} },
} as const;
const DE_CONSULTA = new Set(['appointment_attended', 'appointment_no_show']);
const QUARTA_MANHA = new Date('2026-09-16T13:00:00.000Z');

function fatos(p: Partial<FatosDoEnvio> = {}): FatosDoEnvio {
  return {
    enrollment: { id: 'e0000000-0000-4000-8000-000000000002', status: 'active', started_at: '2026-09-15T12:00:00.000Z', pointer_id: 'p1' },
    trigger_config: GATILHOS.appointment_attended,
    contato: { is_blocked: false, force_human: false, is_anonymized: false },
    handoff_policy: 'allow',
    conversa: { bot_silenciado: false, atribuida_a_pessoa: false, humano_respondeu: false },
    liberacao: { ai_gate: null, ai_gate_mode: null, ai_test_phone_numbers: null, telefone: '+5585987654321', ai_autorizado_em: null, ttl_ms: 21 * 86_400_000 },
    negocios_abertos: [{ stage_id: ETAPA, stage_blocks_followups: false }],
    ultima_recebida_em: '2026-09-15T11:00:00.000Z',
    ultimo_envio_da_inscricao_em: null,
    consultas_confirmadas_futuras: 0,
    outras_inscricoes_vivas: [],
    reserva: null,
    fim_da_janela_automatica: null,
    ...p,
  };
}

const ENCERRA = { envia: false, motivo: 'atendimento_humano', invalida: true };
const ENVIA = { envia: true };

describe('decidirEnvio — gatilho × passo × IA pausada × force_human × handoff_policy', () => {
  // O oráculo diz a regra do dono em palavras, célula a célula.
  function esperado(gatilho: string, passo: 'fixo' | 'ia', silenciada: boolean, forceHuman: boolean, politica: string) {
    const pausaSoCalaAIA = DE_CONSULTA.has(gatilho) && politica === 'allow';
    if (silenciada && !pausaSoCalaAIA) return ENCERRA; // como sempre foi
    if (passo === 'ia' && forceHuman) return { envia: false, motivo: 'atendimento_humano', pula: true }; // PR 355
    if (passo === 'ia' && silenciada) return { envia: false, motivo: 'ia_pausada', pula: true }; // novo
    return ENVIA;
  }
  for (const [gatilho, trigger_config] of Object.entries(GATILHOS)) {
    for (const handoff_policy of ['pause', 'cancel', 'allow'] as const) {
      it(`${gatilho} · ${handoff_policy}`, () => {
        for (const passo of ['fixo', 'ia'] as const) {
          for (const bot_silenciado of [false, true]) {
            for (const force_human of [false, true]) {
              const f = fatos({
                trigger_config,
                handoff_policy,
                contato: { is_blocked: false, force_human, is_anonymized: false },
                conversa: { bot_silenciado, atribuida_a_pessoa: false, humano_respondeu: false },
              });
              expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA, passo), `${passo} silenciada=${bot_silenciado} force_human=${force_human}`)
                .toEqual(esperado(gatilho, passo, bot_silenciado, force_human, handoff_policy));
            }
          }
        }
      });
    }
  }

  it('o caso da clínica, escrito à mão: handoff da IA (force_human + infinity) no pós-consulta com allow', () => {
    const f = fatos({
      contato: { is_blocked: false, force_human: true, is_anonymized: false },
      conversa: { bot_silenciado: true, atribuida_a_pessoa: true, humano_respondeu: true },
    });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA, 'fixo')).toEqual(ENVIA);
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA, 'ia')).toMatchObject({ envia: false, pula: true });
    // Sem dizer o tipo, vale IA.
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toMatchObject({ envia: false, pula: true });
  });

  it('com a IA pausada, o que encerra continua encerrando no pós-consulta', () => {
    const pausada = { bot_silenciado: true, atribuida_a_pessoa: false, humano_respondeu: false };
    const d = (p: Partial<FatosDoEnvio>) => decidirEnvio(fatos({ conversa: pausada, ...p }), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA, 'fixo');
    expect(d({ contato: { is_blocked: true, force_human: false, is_anonymized: false } })).toEqual({ envia: false, motivo: 'opt_out', invalida: true });
    expect(d({ contato: { is_blocked: false, force_human: false, is_anonymized: true } })).toEqual({ envia: false, motivo: 'contato_anonimizado', invalida: true });
    expect(d({ contato: { is_blocked: false, force_human: false, is_anonymized: false, oculto: true } })).toEqual({ envia: false, motivo: 'contato_oculto', invalida: true });
    expect(d({ enrollment: { ...fatos().enrollment, status: 'cancelled' } })).toEqual({ envia: false, motivo: 'inscricao_encerrada', invalida: false });
    expect(d({ negocios_abertos: [{ stage_id: ETAPA, stage_blocks_followups: true }] })).toEqual({ envia: false, motivo: 'etapa_bloqueia_followup', invalida: true });
    // cancel_on_reply: ligado, a resposta do contato encerra; desligado (a clínica), não.
    const respondeu = { ultima_recebida_em: '2026-09-16T12:00:00.000Z' };
    expect(d({ ...respondeu, trigger_config: { ...GATILHOS.appointment_attended, cancel_on_reply: true } })).toEqual({ envia: false, motivo: 'resposta_do_contato', invalida: true });
    expect(d(respondeu)).toEqual(ENVIA);
    // A janela da organização ainda adia.
    const janela = { timezone: 'America/Sao_Paulo', dias: [1, 2, 3, 4, 5], intervalos: [{ inicio: '08:00', fim: '18:00' }] };
    expect(decidirEnvio(fatos({ conversa: pausada }), { ...CONFIG_SEM_BLOQUEIOS_OPCIONAIS, janela }, new Date('2026-09-16T23:00:00.000Z'), 'fixo'))
      .toMatchObject({ envia: false, motivo: 'fora_da_janela' });
  });

  it('o predicado: só gatilho de consulta com allow; lixo não liga', () => {
    expect(fixasIgnoramAPausaDaIA(GATILHOS.appointment_attended, 'allow')).toBe(true);
    expect(fixasIgnoramAPausaDaIA(GATILHOS.appointment_no_show, 'allow')).toBe(true);
    expect(fixasIgnoramAPausaDaIA(GATILHOS.appointment_attended, 'pause')).toBe(false);
    expect(fixasIgnoramAPausaDaIA(GATILHOS.appointment_attended, null)).toBe(false);
    expect(fixasIgnoramAPausaDaIA(GATILHOS.silence, 'allow')).toBe(false);
    expect(fixasIgnoramAPausaDaIA(null, 'allow')).toBe(false);
    expect(fixasIgnoramAPausaDaIA('appointment_attended', 'allow')).toBe(false);
  });

  it('o pulo tem texto próprio, que não diz "sequência encerrada"', () => {
    expect(TEXTO_DO_PULO.ia_pausada).toContain('Passo pulado');
    expect(TEXTO_DO_PULO.ia_pausada).not.toContain('encerrada');
  });
});

// ─── caminho do worker ───────────────────────────────────────────────────────

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
  trigger_config: unknown;
  handoff_policy: 'pause' | 'cancel' | 'allow';
  force_human?: boolean;
  is_blocked?: boolean;
}

/** Pool que responde como o Postgres, com a IA PAUSADA na conversa. `isLeadInHandoff` é o real. */
function fakePool(e: Estado) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> => {
    if (sql.includes('d.fechada_em::text')) return { rows: [{ ...boundary, status: 'open', demanda_fechada_em: null }] };
    if (/from send_ledger l/.test(sql)) return { rows: [{ status: 'accepted', error_code: null }] };
    if (sql.includes('as handoff')) return { rows: [{ handoff: true }] };
    if (sql.includes('insert into cron_jobs')) return { rows: [{ id: 'cron-1' }] };
    if (sql.includes('select current_node_id, status from followup_enrollments')) return { rows: [{ current_node_id: 'node-1', status: 'active' }], rowCount: 1 };
    if (sql.includes('e.status, e.current_node_id, e.steps_taken, p.handoff_policy')) {
      return { rows: [{ status: 'active', current_node_id: 'node-1', steps_taken: 3, handoff_policy: e.handoff_policy, fim_do_silencio_ms: null }] };
    }
    if (sql.includes('select p.trigger_config, p.handoff_policy')) {
      return { rows: [{ trigger_config: e.trigger_config, handoff_policy: e.handoff_policy }] };
    }
    if (/from conversations/.test(sql)) {
      return { rows: [{
        id: CONVERSA, channel_session_id: 'canal-1', archived_at: null, bot_silenciado: true,
        provider: DEFAULT_CHANNEL_PROVIDER, last_inbound_at: new Date(Date.now() - 3_600_000),
      }] };
    }
    if (/from followup_enrollments e\b/.test(sql)) {
      return { rows: [{
        id: ENR, status: 'active', started_at: new Date(0), pointer_id: '22222222-2222-4222-8222-222222222222',
        trigger_config: e.trigger_config, handoff_policy: e.handoff_policy, appointment_id: null,
        reserva_criada_em: null, reserva_consulta_em: null, reserva_sujeita_a_sinal: null,
      }] };
    }
    if (/from contacts/.test(sql)) {
      return { rows: [{ name: 'Maria Souza', display_name: 'Maria Souza', is_blocked: e.is_blocked === true, force_human: e.force_human === true, is_anonymized: false, oculto: false }] };
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
beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import('@/lib/agent-engine/agent/followup-turn'));
}, 60_000);
beforeEach(() => {
  cadeiaFalsa.mockClear();
  runAgentTurn.mockClear();
});

const resultado = (complete: ReturnType<typeof vi.fn>) => (complete.mock.calls[0]?.[1] as { result?: unknown } | undefined)?.result;
const POS_CONSULTA = { trigger_config: GATILHOS.appointment_attended, handoff_policy: 'allow' } as const;

describe('worker: pós-consulta com a IA pausada', () => {
  for (const force_human of [false, true]) {
    it(`texto fixo SAI (force_human=${force_human})`, async () => {
      const d = deps();
      await criarHandler(d.deps)(job({ fixed_body: 'Oi {{primeiro_nome}}, como está a pele?' }), fakePool({ ...POS_CONSULTA, force_human }), ctx);
      expect(d.send).toHaveBeenCalledTimes(1);
      expect(d.send.mock.calls[0]![0]).toMatchObject({ body: 'Oi Maria, como está a pele?' });
      expect(resultado(d.complete)).toEqual({ kind: 'sent' });
      expect(runAgentTurn).not.toHaveBeenCalled();
    });
  }

  it('passo de IA é PULADO (o fluxo segue), sem chamar o modelo', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ prompt_hint: 'pergunte como foi' }), fakePool(POS_CONSULTA), ctx);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: 'pulado', reason: TEXTO_DO_PULO.ia_pausada });
  });

  it('controle: STOP encerra o passo fixo com opt-out', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: 'Oi' }), fakePool({ ...POS_CONSULTA, is_blocked: true }), ctx);
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: 'skipped', reason: TEXTO_DO_BLOQUEIO.opt_out, outcome: 'opted_out' });
  });

  it('controle: follow-up de lead (silêncio) com allow continua ENCERRANDO', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: 'Oi' }), fakePool({ trigger_config: GATILHOS.silence, handoff_policy: 'allow' }), ctx);
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toEqual({ kind: 'skipped', reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome: 'handoff' });
  });

  it('controle: pós-consulta com pause continua ADIANDO (a escolha do operador vale)', async () => {
    const d = deps();
    await criarHandler(d.deps)(job({ fixed_body: 'Oi' }), fakePool({ trigger_config: GATILHOS.appointment_attended, handoff_policy: 'pause' }), ctx);
    expect(d.send).not.toHaveBeenCalled();
    expect(resultado(d.complete)).toMatchObject({ kind: 'deferred', reason: 'pessoa_no_comando' });
  });
});

// ─── as portas que não recebem os fatos de `decidirEnvio` ─────────────────────

describe('passoFixoIgnoraPausaDaIA: lê o job e o pointer, nunca quem chama', () => {
  const FIXO = { followup_enrollment_id: ENR, purpose: 'send_message', fixed_body: 'Oi' };
  const db = (linha: Record<string, unknown> | null) => {
    const query = vi.fn(async (..._a: unknown[]) => ({ rows: linha === null ? [] : [linha] }));
    return { query, pool: { query } as never as Parameters<typeof passoFixoIgnoraPausaDaIA>[0] };
  };
  const alvo = (payload: Record<string, unknown> | null, kind = 'followup_turn') => ({ organizationId: ORG, contactId: LEAD, kind, payload });

  it('passo fixo + gatilho de consulta + allow: sim, lendo o pointer pela inscrição do job', async () => {
    const d = db({ trigger_config: GATILHOS.appointment_attended, handoff_policy: 'allow' });
    expect(await passoFixoIgnoraPausaDaIA(d.pool, alvo(FIXO))).toBe(true);
    expect(d.query.mock.calls[0]).toEqual([expect.stringContaining('followup_flow_pointers'), [ORG, ENR, LEAD]]);
  });
  it('não: gatilho de lead, pause, inscrição de outro contato (sem linha)', async () => {
    expect(await passoFixoIgnoraPausaDaIA(db({ trigger_config: GATILHOS.silence, handoff_policy: 'allow' }).pool, alvo(FIXO))).toBe(false);
    expect(await passoFixoIgnoraPausaDaIA(db({ trigger_config: GATILHOS.appointment_attended, handoff_policy: 'pause' }).pool, alvo(FIXO))).toBe(false);
    expect(await passoFixoIgnoraPausaDaIA(db(null).pool, alvo(FIXO))).toBe(false);
  });
  it('passo de IA, job que não é de fluxo e contato ausente: não, sem nem consultar', async () => {
    const d = db({ trigger_config: GATILHOS.appointment_attended, handoff_policy: 'allow' });
    expect(await passoFixoIgnoraPausaDaIA(d.pool, alvo({ ...FIXO, fixed_body: undefined, prompt_hint: 'x' }))).toBe(false);
    expect(await passoFixoIgnoraPausaDaIA(d.pool, alvo(FIXO, 'agent_turn'))).toBe(false);
    expect(await passoFixoIgnoraPausaDaIA(d.pool, { ...alvo(FIXO), contactId: null })).toBe(false);
    expect(d.query).not.toHaveBeenCalled();
  });
});

describe('envio bolha a bolha (`pessoaNoComandoDaConversa`) com `ignorarPausaDaIA`', () => {
  const linha = (over: Record<string, unknown>) => ({
    query: vi.fn(async () => ({
      rows: [{ contato_oculto: false, channel_metadata: {}, force_human: true, assignee_kind: 'user', bot_silenced_until: 'infinity', ai_authorized_at: null, phone_number: '+5585987654321', provider: DEFAULT_CHANNEL_PROVIDER, ...over }],
    })),
  }) as never;
  const alvo = { organizationId: ORG, conversationId: CONVERSA };

  it('silêncio, dono humano e force_human não barram; sem a opção, barram', async () => {
    expect(await pessoaNoComandoDaConversa(linha({}), alvo, 'followup_turn', { ignorarPausaDaIA: true })).toBeNull();
    expect(await pessoaNoComandoDaConversa(linha({}), alvo, 'followup_turn')).not.toBeNull();
    expect(await pessoaNoComandoDaConversa(linha({}), alvo, 'followup_turn', { ignorarTravaDoContato: true })).not.toBeNull();
  });
  it('contato oculto continua barrando', async () => {
    expect(await pessoaNoComandoDaConversa(linha({ contato_oculto: true }), alvo, 'followup_turn', { ignorarPausaDaIA: true })).not.toBeNull();
  });
});
