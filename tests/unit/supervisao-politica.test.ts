/**
 * SUPERVISÃO DE AGENTE — as regras puras: quem aciona, o ciclo, a chave e o
 * formato que o modelo pode devolver.
 *
 * O executor (`supervisao-executor.test.ts`) prova a fiação; aqui fica a forma
 * de cada regra, para que inlinar ou afrouxar uma delas vermelhe no teste que
 * nomeia a regra — e não num caso de ponta que só a atravessa.
 */
import { describe, expect, it } from 'vitest';

import {
  chaveDaAcao,
  chaveDeIdempotencia,
  eventoDeRevisaoSchema,
  uuidDeterministico,
  type EventoDeRevisao,
} from '@/lib/supervisao/contrato';
import {
  codigoDaRevisao,
  decidirAcionamento,
  transicaoAutorizada,
  type VinculoDeSupervisao,
} from '@/lib/supervisao/politica';
import { lerPropostaDoSupervisor } from '@/lib/supervisao/proposta';

const ORG = 'a1000000-0000-4000-8000-000000000001';
const SUPERVISOR = 'a1000000-0000-4000-8000-000000000002';
const ATENDENTE = 'a1000000-0000-4000-8000-000000000003';
const OUTRO_AGENTE = 'a1000000-0000-4000-8000-000000000004';
const FUNIL = 'a1000000-0000-4000-8000-000000000005';
const OUTRO_FUNIL = 'a1000000-0000-4000-8000-000000000006';
const PESSOA = '88888888-8888-4888-8888-888888888888';

const vinculo: VinculoDeSupervisao = {
  id: '11111111-1111-4111-8111-111111111111',
  organization_id: ORG,
  supervisor_agent_id: SUPERVISOR,
  supervised_agent_id: ATENDENTE,
  pipeline_id: FUNIL,
  enabled: true,
  review_human_actions: true,
  mode: 'recomendar',
  allowed_stage_moves: [],
  policy_version: 'v1',
};

function evento(p: Partial<EventoDeRevisao> = {}): EventoDeRevisao {
  return {
    event_id: '55555555-5555-4555-8555-555555555555',
    organization_id: ORG,
    conversation_id: '22222222-2222-4222-8222-222222222222',
    contact_id: '33333333-3333-4333-8333-333333333333',
    lead_id: null,
    pipeline_id: FUNIL,
    actor_type: 'ai_agent',
    actor_id: ATENDENTE,
    occurred_at: '2026-09-16T13:00:00.000Z',
    conversation_revision: '3',
    origin: 'ai_run_completed',
    trace_id: 'job:x',
    ...p,
  };
}

const contexto = {
  supervisoresDaOrganizacao: new Set([SUPERVISOR]),
  vinculoDoUsuario: null,
  originadoPorSupervisao: false,
};

describe('decidirAcionamento — filtro', () => {
  it('aceita a execução da atendente no funil indicado', () => {
    expect(decidirAcionamento(evento(), vinculo, contexto)).toEqual({ aciona: true, bloqueada: false });
  });

  it('vínculo desligado, outra organização, outro funil e outro agente são filtros SILENCIOSOS', () => {
    expect(decidirAcionamento(evento(), { ...vinculo, enabled: false }, contexto)).toEqual({ aciona: false, porque: 'vinculo_desligado' });
    expect(decidirAcionamento(evento({ organization_id: 'a1000000-0000-4000-8000-000000000007' }), vinculo, contexto))
      .toEqual({ aciona: false, porque: 'outra_organizacao' });
    // O funil de MESMO NOME em outra organização não passa: a regra é pelo id.
    expect(decidirAcionamento(evento({ pipeline_id: OUTRO_FUNIL }), vinculo, contexto)).toEqual({ aciona: false, porque: 'outro_funil' });
    expect(decidirAcionamento(evento({ actor_id: OUTRO_AGENTE }), vinculo, contexto))
      .toEqual({ aciona: false, porque: 'agente_nao_supervisionado' });
  });

  it('ação humana exige vínculo validado; ausente ou ambíguo gera revisão BLOQUEADA, não silêncio', () => {
    const humano = evento({ actor_type: 'user', actor_id: PESSOA, origin: 'human_message_sent' });
    expect(decidirAcionamento(humano, vinculo, { ...contexto, vinculoDoUsuario: 'valido' })).toEqual({ aciona: true, bloqueada: false });
    expect(decidirAcionamento(humano, vinculo, { ...contexto, vinculoDoUsuario: 'ausente' }))
      .toEqual({ aciona: true, bloqueada: true, porque: 'usuario_sem_vinculo' });
    expect(decidirAcionamento(humano, vinculo, { ...contexto, vinculoDoUsuario: 'ambiguo' }))
      .toEqual({ aciona: true, bloqueada: true, porque: 'vinculo_do_usuario_ambiguo' });
    expect(decidirAcionamento(humano, { ...vinculo, review_human_actions: false }, { ...contexto, vinculoDoUsuario: 'valido' }))
      .toEqual({ aciona: false, porque: 'acoes_humanas_fora_do_escopo' });
  });
});

describe('decidirAcionamento — ciclo', () => {
  it('a execução do próprio supervisor nunca o aciona', () => {
    expect(decidirAcionamento(evento({ actor_id: SUPERVISOR }), { ...vinculo, supervised_agent_id: SUPERVISOR }, contexto))
      .toEqual({ aciona: false, porque: 'ciclo_do_supervisor' });
  });

  it('o card movido pela revisão não gera revisão de si mesma — nem pela porta humana', () => {
    const movidoPelaRevisao = evento({ actor_type: 'user', actor_id: PESSOA, origin: 'human_stage_changed' });
    expect(
      decidirAcionamento(movidoPelaRevisao, vinculo, { ...contexto, vinculoDoUsuario: 'valido', originadoPorSupervisao: true }),
    ).toEqual({ aciona: false, porque: 'ciclo_do_supervisor' });
  });

  it('o corte do ciclo vem ANTES do filtro de agente supervisionado', () => {
    // Um vínculo mal configurado apontando o supervisor como supervisionado não
    // pode virar laço: o ciclo decide primeiro.
    const r = decidirAcionamento(evento({ actor_id: SUPERVISOR }), { ...vinculo, supervised_agent_id: SUPERVISOR }, contexto);
    expect(r.aciona).toBe(false);
  });
});

describe('chave de idempotência', () => {
  it('é org:conversa:evento:supervisor — sem timestamp nem tentativa', () => {
    expect(chaveDeIdempotencia(evento(), SUPERVISOR)).toBe(
      `${ORG}:22222222-2222-4222-8222-222222222222:55555555-5555-4555-8555-555555555555:${SUPERVISOR}`,
    );
  });

  it('reavaliação deliberada exige NOVO evento: outro event_id, outra chave', () => {
    expect(chaveDeIdempotencia(evento(), SUPERVISOR)).not.toBe(
      chaveDeIdempotencia(evento({ event_id: '55555555-5555-4555-8555-555555555556' }), SUPERVISOR),
    );
  });

  it('o source_event_id do job é determinístico, uuid válido, e difere do evento cru', () => {
    const chave = chaveDeIdempotencia(evento(), SUPERVISOR);
    const a = uuidDeterministico(chave);
    expect(a).toBe(uuidDeterministico(chave));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // O evento cru já é source_event_id do operator_turn do mesmo turno.
    expect(a).not.toBe(evento().event_id);
  });

  it('a chave da ação é estável para a mesma mudança', () => {
    expect(chaveDaAcao('r', 'mover_etapa', 'x')).toBe(chaveDaAcao('r', 'mover_etapa', 'x'));
  });

  it('o evento do contrato é estrito: campo a mais é recusado', () => {
    expect(eventoDeRevisaoSchema.safeParse({ ...evento(), extra: 1 }).success).toBe(false);
    expect(eventoDeRevisaoSchema.safeParse(evento()).success).toBe(true);
  });
});

describe('transições autorizadas e código da revisão', () => {
  const permitidas = [{ to_stage_id: 'b', from_stage_ids: ['a'] }, { to_stage_id: 'c', from_stage_ids: [] }];

  it('só a origem listada autoriza; lista de origem vazia aceita qualquer origem', () => {
    expect(transicaoAutorizada(permitidas, 'a', 'b')).toBe(true);
    expect(transicaoAutorizada(permitidas, 'z', 'b')).toBe(false);
    expect(transicaoAutorizada(permitidas, 'z', 'c')).toBe(true);
    expect(transicaoAutorizada([], 'a', 'b')).toBe(false);
  });

  it('EXE só com ação executada; decisão sem execução não conta', () => {
    expect(codigoDaRevisao(['executada', 'bloqueada'])).toBe('EXE');
    expect(codigoDaRevisao(['recomendada', 'bloqueada'])).toBe('RECOM');
    expect(codigoDaRevisao(['bloqueada'])).toBe('BLOQ');
    expect(codigoDaRevisao(['falhou'])).toBe('BLOQ');
    expect(codigoDaRevisao([])).toBeNull();
  });
});

describe('lerPropostaDoSupervisor', () => {
  const valida = {
    classificacao: 'paciente',
    avaliacao: 'ok',
    movimentacao: null,
    pendencias: [],
    exige_revisao_humana: false,
    tema_sensivel: null,
  };

  it('aceita o JSON mesmo cercado de texto', () => {
    expect(lerPropostaDoSupervisor(`Segue:\n${JSON.stringify(valida)}\nfim`).ok).toBe(true);
  });

  it('recusa texto sem JSON, JSON quebrado e campos fora do contrato', () => {
    expect(lerPropostaDoSupervisor('Está tudo certo.')).toEqual({ ok: false, porque: 'sem_json' });
    expect(lerPropostaDoSupervisor('{ "classificacao": ')).toEqual({ ok: false, porque: 'sem_json' });
    expect(lerPropostaDoSupervisor('{"classificacao": }')).toEqual({ ok: false, porque: 'json_invalido' });
    // Uma "ação" que o contrato não prevê (enviar mensagem) é formato inválido.
    expect(lerPropostaDoSupervisor(JSON.stringify({ ...valida, enviar_mensagem: 'Olá' })))
      .toEqual({ ok: false, porque: 'formato_invalido' });
    expect(lerPropostaDoSupervisor(JSON.stringify({ ...valida, movimentacao: { para_etapa_id: 'Consulta agendada', motivo: 'x', evidencias: [] } })))
      .toEqual({ ok: false, porque: 'formato_invalido' });
  });
});
