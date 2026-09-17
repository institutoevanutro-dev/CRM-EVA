/**
 * SUPERVISÃO DE AGENTE — os seis critérios de aceitação, reentrega e concorrência.
 *
 * ## O que este arquivo prova, e o que ele NÃO prova
 *
 * Prova a DECISÃO e, separadamente, o EFEITO que o executor pede ao banco: um
 * banco em memória (`BancoFalso`) implementa `SupervisaoDb` com as mesmas
 * regras de trava e idempotência do adaptador pg, e cada caso confere o estado
 * FINAL do negócio — não a frase do modelo. Uma resposta textual correta não
 * move card; o que se assere aqui é se o card se moveu.
 *
 * Não prova o SQL do adaptador (`lib/supervisao/db-pg.ts`) contra Postgres real:
 * isso é trabalho de `tests/invariants/**` (`pnpm test:db`). Os registros são
 * sintéticos e nenhum envio externo existe: o executor não recebe canal, e o
 * último teste afirma essa ausência na forma dos contratos.
 */
import { describe, expect, it } from 'vitest';

import { chaveDeIdempotencia } from '@/lib/supervisao/contrato';
import {
  executarRevisao,
  type AcaoRow,
  type RevisaoRow,
  type SupervisaoDb,
  type SupervisaoDeps,
} from '@/lib/supervisao/executor';
import type { EstadoLido, EtapaLida, VinculoDeSupervisao } from '@/lib/supervisao/politica';

// ─── ids sintéticos ──────────────────────────────────────────────────────────

const ORG = '39bcf401-7767-4f78-b02c-94c0069c3e63';
const ERICK = '2c68cf79-5557-4bc6-8c27-2803d76e7e85';
const CINTIA = '1f38936b-1f0f-4e7d-b2ea-ee9cb9631bde';
const FUNIL = '67621cbb-63a3-4ec4-acf3-f0b97dc60254';
const VINCULO = '11111111-1111-4111-8111-111111111111';
const CONVERSA = '22222222-2222-4222-8222-222222222222';
const CONTATO = '33333333-3333-4333-8333-333333333333';
const LEAD = '44444444-4444-4444-8444-444444444444';
const EVENTO = '55555555-5555-4555-8555-555555555555';
const REVISAO = '66666666-6666-4666-8666-666666666666';
const M1 = '77777777-7777-4777-8777-777777777771';
const M2 = '77777777-7777-4777-8777-777777777772';
const HUMANO = '88888888-8888-4888-8888-888888888888';

const E = {
  novo: 'a0000000-0000-4000-8000-000000000001',
  emAtendimento: 'a0000000-0000-4000-8000-000000000002',
  entendendo: 'a0000000-0000-4000-8000-000000000003',
  agendamento: 'a0000000-0000-4000-8000-000000000004',
  aguardandoSinal: 'a0000000-0000-4000-8000-000000000005',
  comprovante: 'a0000000-0000-4000-8000-000000000006',
  consultaAgendada: 'a0000000-0000-4000-8000-000000000007',
  compareceu: 'a0000000-0000-4000-8000-000000000008',
  naoAvancou: 'a0000000-0000-4000-8000-000000000009',
} as const;

const ETAPAS: EtapaLida[] = [
  etapa(E.novo, 'Novo contato'),
  etapa(E.emAtendimento, 'Em atendimento'),
  etapa(E.entendendo, 'Entendendo a necessidade'),
  etapa(E.agendamento, 'Agendamento em andamento'),
  etapa(E.aguardandoSinal, 'Aguardando sinal'),
  { ...etapa(E.comprovante, 'Comprovante em conferência'), blocks_followups: true },
  { ...etapa(E.consultaAgendada, 'Consulta agendada'), is_won: true },
  etapa(E.compareceu, 'Compareceu / em acompanhamento'),
  { ...etapa(E.naoAvancou, 'Não avançou'), is_lost: true },
];

function etapa(id: string, name: string): EtapaLida {
  return { id, name, is_won: false, is_lost: false, is_archived: false, requires_human: false, blocks_followups: false };
}

const VINCULO_DA_CLINICA: VinculoDeSupervisao = {
  id: VINCULO,
  organization_id: ORG,
  supervisor_agent_id: ERICK,
  supervised_agent_id: CINTIA,
  pipeline_id: FUNIL,
  enabled: true,
  review_human_actions: true,
  mode: 'executar',
  allowed_stage_moves: [
    { to_stage_id: E.comprovante, from_stage_ids: [E.aguardandoSinal] },
    { to_stage_id: E.agendamento, from_stage_ids: [E.entendendo] },
  ],
  policy_version: 'eva-v1',
};

const OCORREU = '2026-09-16T13:00:00.000Z';

// ─── banco em memória ────────────────────────────────────────────────────────

interface Cenario {
  etapa: string;
  statusDoNegocio?: 'open' | 'won' | 'lost';
  optOut?: boolean;
  mensagens?: Array<{ id: string; direction: 'inbound' | 'outbound'; body: string }>;
  followupsVivos?: number;
  ator?: { tipo: 'ai_agent' | 'user'; id: string };
}

class BancoFalso implements SupervisaoDb {
  revisao: RevisaoRow;
  vinculo: VinculoDeSupervisao = VINCULO_DA_CLINICA;
  lead: { stage_id: string; status: string; stage_changed_at: string };
  serviceRevision = '7';
  contato: { is_blocked: boolean; force_human: boolean; is_anonymized: boolean };
  mensagens: EstadoLido['mensagens'];
  followupsVivos: number;
  acoes = new Map<string, AcaoRow & { reason: string; target: string | null }>();
  pendencias: Array<{ ref: string; action_key: string; titulo: string }> = [];
  atividadesDeMovimento: Array<{ id: string; action_key: string; para: string }> = [];
  mudancasHumanas: Array<{ activity_id: string; performed_at: string }> = [];
  timeline: string[] = [];
  escritasDeEtapa = 0;
  /** Roda uma vez, entre a leitura e a escrita condicional. */
  antesDaEscrita: (() => void) | null = null;
  /** Falha uma vez ao gravar o desfecho da ação (queda depois do commit). */
  falharAoFinalizar = false;

  constructor(c: Cenario) {
    this.lead = { stage_id: c.etapa, status: c.statusDoNegocio ?? 'open', stage_changed_at: '2026-09-16T12:00:00.000Z' };
    this.contato = { is_blocked: c.optOut ?? false, force_human: false, is_anonymized: false };
    this.followupsVivos = c.followupsVivos ?? 0;
    this.mensagens = (c.mensagens ?? []).map((m, i) => ({
      id: m.id,
      direction: m.direction,
      sent_via: m.direction === 'inbound' ? 'crm' : 'ai',
      sent_by_user_id: null,
      type: 'text',
      created_at: new Date(Date.parse(OCORREU) - (10 - i) * 60_000).toISOString(),
      body: m.body,
    }));
    const ator: { tipo: 'ai_agent' | 'user'; id: string } = c.ator ?? { tipo: 'ai_agent', id: CINTIA };
    const evento = {
      event_id: EVENTO,
      organization_id: ORG,
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      lead_id: LEAD,
      pipeline_id: FUNIL,
      actor_type: ator.tipo,
      actor_id: ator.id,
      occurred_at: OCORREU,
      conversation_revision: '7',
      origin: ator.tipo === 'ai_agent' ? ('ai_run_completed' as const) : ('human_message_sent' as const),
      trace_id: `job:${EVENTO}`,
    };
    this.revisao = {
      ...evento,
      id: REVISAO,
      binding_id: VINCULO,
      idempotency_key: chaveDeIdempotencia(evento, ERICK),
      supervisor_agent_id: ERICK,
      status: 'pendente',
      outcome_code: null,
      policy_version: 'eva-v1',
      proposal: null,
      exit_reason: null,
      attempts: 0,
    };
  }

  async carregarRevisao(orgId: string, id: string): Promise<RevisaoRow | null> {
    return orgId === ORG && id === REVISAO ? { ...this.revisao } : null;
  }
  async iniciarRevisao(orgId: string, id: string): Promise<RevisaoRow | null> {
    if (orgId !== ORG || id !== REVISAO) return null;
    if (this.revisao.status === 'concluida' || this.revisao.status === 'bloqueada') return null;
    this.revisao = { ...this.revisao, status: 'em_execucao', attempts: this.revisao.attempts + 1 };
    return { ...this.revisao };
  }
  async carregarVinculo(): Promise<VinculoDeSupervisao | null> {
    return this.vinculo;
  }
  async supervisoresDaOrganizacao(): Promise<Set<string>> {
    return new Set([ERICK]);
  }
  async vinculoDoUsuario(_org: string, userId: string) {
    return userId === HUMANO ? ('valido' as const) : ('ausente' as const);
  }
  async lerEstado(): Promise<EstadoLido> {
    return {
      lida_em: new Date().toISOString(),
      lead: { id: LEAD, pipeline_id: FUNIL, ...this.lead, owner_kind: 'ai', owner_user_id: null },
      contato: { ...this.contato },
      conversa: { id: CONVERSA, service_revision: this.serviceRevision, assigned_to_user_id: null, em_atendimento_humano: false },
      etapas: ETAPAS,
      mensagens: this.mensagens,
      mudancas_humanas_de_etapa_apos_evento: [...this.mudancasHumanas],
      mensagens_humanas_apos_evento: [],
      agendamentos_futuros: [],
      followups_vivos: Array.from({ length: this.followupsVivos }, (_, i) => ({
        id: `b0000000-0000-4000-8000-00000000000${i}`,
        status: 'active',
        pointer_id: 'c0000000-0000-4000-8000-000000000001',
      })),
    };
  }
  async gravarProposta(_o: string, _r: string, proposta: unknown): Promise<void> {
    if (this.revisao.proposal === null) this.revisao = { ...this.revisao, proposal: proposta };
  }
  async carregarAcao(_o: string, actionKey: string): Promise<AcaoRow | null> {
    const a = this.acoes.get(actionKey);
    return a ? { ...a } : null;
  }
  async registrarAcao(input: Parameters<SupervisaoDb['registrarAcao']>[0]): Promise<AcaoRow> {
    const existente = this.acoes.get(input.action_key);
    if (existente) return { ...existente };
    const nova = {
      id: `d0000000-0000-4000-8000-${String(this.acoes.size).padStart(12, '0')}`,
      action_key: input.action_key,
      kind: input.kind,
      expected_stage_id: input.expected_stage_id,
      status: 'pendente' as const,
      code: null,
      tool_result_ref: null,
      reason: input.reason,
      target: input.target_stage_id,
    };
    this.acoes.set(input.action_key, nova);
    return { ...nova };
  }
  async finalizarAcao(_o: string, actionId: string, patch: Parameters<SupervisaoDb['finalizarAcao']>[2]): Promise<void> {
    if (this.falharAoFinalizar) {
      this.falharAoFinalizar = false;
      throw new Error('queda simulada depois do commit');
    }
    // O CHECK da 0263, reproduzido: EXE sem referência de resultado é recusado.
    if (patch.code === 'EXE' && (patch.status !== 'executada' || patch.tool_result_ref === null)) {
      throw new Error('ai_supervision_actions_exe_has_result');
    }
    for (const [k, a] of this.acoes) {
      if (a.id === actionId && (a.status === 'pendente' || a.status === 'falhou')) {
        this.acoes.set(k, { ...a, status: patch.status, code: patch.code, tool_result_ref: patch.tool_result_ref });
      }
    }
  }
  async moverEtapaComTrava(input: Parameters<SupervisaoDb['moverEtapaComTrava']>[0]) {
    const ja = this.atividadesDeMovimento.find((a) => a.action_key === input.action_key);
    if (ja) return { ok: true as const, ref: ja.id };
    if (this.antesDaEscrita) {
      const f = this.antesDaEscrita;
      this.antesDaEscrita = null;
      f();
    }
    const alvo = ETAPAS.find((e) => e.id === input.para_etapa_id);
    const trava =
      this.lead.status === 'open' &&
      this.lead.stage_id === input.de_etapa_id &&
      this.lead.stage_changed_at === input.stage_changed_at_esperado &&
      this.serviceRevision === input.service_revision_esperada &&
      alvo !== undefined && !alvo.is_won && !alvo.is_lost;
    if (!trava) return { ok: false as const, porque: 'conflito' as const };
    this.escritasDeEtapa += 1;
    this.lead = { ...this.lead, stage_id: input.para_etapa_id, stage_changed_at: new Date(Date.now() + this.escritasDeEtapa).toISOString() };
    const id = `e0000000-0000-4000-8000-${String(this.atividadesDeMovimento.length).padStart(12, '0')}`;
    this.atividadesDeMovimento.push({ id, action_key: input.action_key, para: input.para_etapa_id });
    return { ok: true as const, ref: id };
  }
  async abrirPendencia(input: Parameters<SupervisaoDb['abrirPendencia']>[0]) {
    const ja = this.pendencias.find((p) => p.action_key === input.action_key);
    if (ja) return { ref: ja.ref };
    const ref = `agent_inbox_items:f0000000-0000-4000-8000-${String(this.pendencias.length).padStart(12, '0')}`;
    this.pendencias.push({ ref, action_key: input.action_key, titulo: input.titulo });
    return { ref };
  }
  async concluirRevisao(_o: string, _r: string, patch: Parameters<SupervisaoDb['concluirRevisao']>[2]): Promise<void> {
    this.revisao = { ...this.revisao, status: patch.status, outcome_code: patch.outcome_code, exit_reason: patch.exit_reason };
  }
  async registrarAtividade(input: Parameters<SupervisaoDb['registrarAtividade']>[0]): Promise<void> {
    this.timeline.push(`${input.codigo}:${input.contagem.EXE}/${input.contagem.RECOM}/${input.contagem.BLOQ}`);
  }

  acoesPorCodigo(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const a of this.acoes.values()) r[a.code ?? 'pendente'] = (r[a.code ?? 'pendente'] ?? 0) + 1;
    return r;
  }
}

function deps(banco: BancoFalso, proposta: unknown): SupervisaoDeps & { chamadas: () => number } {
  let chamadas = 0;
  return {
    db: banco,
    async carregarSupervisor() {
      return { agentId: ERICK, versionId: '99999999-9999-4999-8999-999999999999', politicas: 'Políticas da clínica.' };
    },
    async proporRevisao() {
      chamadas += 1;
      return typeof proposta === 'string' ? proposta : JSON.stringify(proposta);
    },
    chamadas: () => chamadas,
  };
}

function proposta(p: Partial<{
  classificacao: string;
  movimentacao: { para_etapa_id: string; motivo: string; evidencias: string[] } | null;
  pendencias: Array<{ motivo: string; responsavel: string; evidencias: string[] }>;
  exige_revisao_humana: boolean;
  tema_sensivel: string | null;
}>) {
  return {
    classificacao: 'paciente',
    avaliacao: 'Revisão administrativa da execução.',
    movimentacao: null,
    pendencias: [],
    exige_revisao_humana: false,
    tema_sensivel: null,
    ...p,
  };
}

// ─── os seis critérios ───────────────────────────────────────────────────────

describe('critério 1 — comprovante enviado', () => {
  const cenario = (): BancoFalso =>
    new BancoFalso({
      etapa: E.aguardandoSinal,
      followupsVivos: 1,
      mensagens: [
        { id: M1, direction: 'outbound', body: 'Para confirmar, o sinal é de R$ 100 por Pix.' },
        { id: M2, direction: 'inbound', body: '[imagem] segue o comprovante' },
      ],
    });

  it('move para Comprovante em conferência (EXE) e registra a conferência humana pendente (RECOM)', async () => {
    const banco = cenario();
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.comprovante, motivo: 'Contato enviou comprovante do sinal.', evidencias: [M2] },
      pendencias: [{ motivo: 'Conferir o comprovante do sinal.', responsavel: 'financeiro', evidencias: [M2] }],
    }));
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ tipo: 'concluida', status: 'concluida', codigo: 'EXE' });
    expect(banco.lead.stage_id).toBe(E.comprovante);
    expect(banco.acoesPorCodigo()).toEqual({ EXE: 1, RECOM: 1 });
    expect(banco.pendencias).toHaveLength(1);
  });

  it('NUNCA move para Consulta agendada, mesmo que o modelo proponha — BLOQ e o card fica onde estava', async () => {
    const banco = cenario();
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.consultaAgendada, motivo: 'Pagamento recebido.', evidencias: [M2] },
    }));
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ codigo: 'BLOQ' });
    expect(banco.lead.stage_id).toBe(E.aguardandoSinal);
    expect(banco.escritasDeEtapa).toBe(0);
  });

  it('com o vínculo só recomendando, o mesmo caso vira RECOM e nada é escrito no funil', async () => {
    const banco = cenario();
    banco.vinculo = { ...VINCULO_DA_CLINICA, mode: 'recomendar' };
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.comprovante, motivo: 'Contato enviou comprovante.', evidencias: [M2] },
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.aguardandoSinal);
    expect(banco.acoesPorCodigo()).toEqual({ RECOM: 1 });
  });
});

describe('critério 2 — opt-out', () => {
  it('não classifica como Não avançou: a perda proposta é BLOQ e o card fica', async () => {
    const banco = new BancoFalso({
      etapa: E.agendamento,
      optOut: true,
      followupsVivos: 2,
      mensagens: [{ id: M1, direction: 'inbound', body: 'parem de me mandar mensagem' }],
    });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.naoAvancou, motivo: 'Pediu para parar.', evidencias: [M1] },
      pendencias: [{ motivo: 'Contato pediu para não receber mensagens; conferir bloqueio das sequências.', responsavel: 'equipe', evidencias: [M1] }],
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.agendamento);
    expect(banco.escritasDeEtapa).toBe(0);
    expect(banco.acoesPorCodigo()).toEqual({ BLOQ: 1, RECOM: 1 });
  });
});

describe('critério 3 — silêncio depois do D7', () => {
  it('registra a sequência concluída sem resposta para revisão, sem marcar perda', async () => {
    const banco = new BancoFalso({
      etapa: E.agendamento,
      mensagens: [{ id: M1, direction: 'outbound', body: 'Vou encerrar por aqui as mensagens sobre esse agendamento.' }],
    });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.naoAvancou, motivo: 'Sem resposta após D7.', evidencias: [M1] },
      pendencias: [{ motivo: 'Sequência concluída sem resposta; decidir o próximo passo.', responsavel: 'equipe', evidencias: [M1] }],
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.agendamento);
    expect(banco.pendencias.length).toBeGreaterThanOrEqual(1);
    expect([...banco.acoes.values()].some((a) => a.code === 'EXE')).toBe(false);
  });
});

describe('critério 4 — paciente já agendado pergunta o endereço', () => {
  it('preserva Consulta agendada: negócio fechado não volta para Em atendimento', async () => {
    const banco = new BancoFalso({
      etapa: E.consultaAgendada,
      statusDoNegocio: 'won',
      mensagens: [{ id: M1, direction: 'inbound', body: 'qual o endereço da clínica?' }],
    });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.emAtendimento, motivo: 'Nova dúvida.', evidencias: [M1] },
      pendencias: [{ motivo: 'Dúvida administrativa sobre endereço.', responsavel: 'equipe', evidencias: [M1] }],
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.consultaAgendada);
    expect(banco.escritasDeEtapa).toBe(0);
    expect(banco.acoesPorCodigo()).toEqual({ BLOQ: 1, RECOM: 1 });
  });
});

describe('critério 5 — fornecedor', () => {
  it('fica fora do funil comercial: nenhuma movimentação, encaminhamento interno como RECOM', async () => {
    const banco = new BancoFalso({
      etapa: E.novo,
      mensagens: [{ id: M1, direction: 'inbound', body: 'Sou representante e gostaria de apresentar nossos serviços à administração.' }],
    });
    const d = deps(banco, proposta({
      classificacao: 'fornecedor',
      pendencias: [{ motivo: 'Contato comercial de fornecedor para a administração.', responsavel: 'administracao', evidencias: [M1] }],
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.novo);
    expect(banco.acoesPorCodigo()).toEqual({ RECOM: 1 });
  });

  it('etapa inventada pelo modelo é BLOQ, nunca criada', async () => {
    const banco = new BancoFalso({ etapa: E.novo, mensagens: [{ id: M1, direction: 'inbound', body: 'fornecedor' }] });
    const d = deps(banco, proposta({
      classificacao: 'fornecedor',
      movimentacao: { para_etapa_id: 'a0000000-0000-4000-8000-0000000000ff', motivo: 'Etapa Fornecedores.', evidencias: [M1] },
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.novo);
    expect(banco.acoesPorCodigo()).toEqual({ BLOQ: 1 });
  });
});

describe('critério 6 — retorno médico elegível pede agendamento', () => {
  it('move para Agendamento em andamento por intenção explícita e registra o pedido para a agenda', async () => {
    const banco = new BancoFalso({
      etapa: E.entendendo,
      mensagens: [
        { id: M1, direction: 'inbound', body: 'quero agendar meu retorno' },
        { id: M2, direction: 'outbound', body: 'Claro! Qual período seria melhor?' },
      ],
    });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.agendamento, motivo: 'Pedido explícito de agendamento do retorno.', evidencias: [M1] },
      pendencias: [{ motivo: 'Retorno incluído, teleconsulta de 30 minutos, sem horário escolhido.', responsavel: 'agenda', evidencias: [M1] }],
    }));
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ codigo: 'EXE' });
    expect(banco.lead.stage_id).toBe(E.agendamento);
    expect(banco.acoesPorCodigo()).toEqual({ EXE: 1, RECOM: 1 });
  });

  it('sem evidência na conversa a movimentação é BLOQ', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo, mensagens: [{ id: M1, direction: 'inbound', body: 'oi' }] });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.agendamento, motivo: 'Quer agendar.', evidencias: ['7777777a-7777-4777-8777-777777777779'] },
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.entendendo);
    expect(banco.acoesPorCodigo()).toEqual({ BLOQ: 1 });
  });
});

// ─── reentrega, concorrência e retentativa ───────────────────────────────────

describe('reentrega do mesmo evento', () => {
  it('devolve o resultado anterior: uma chamada de modelo, uma escrita, nenhuma ação nova', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo, mensagens: [{ id: M1, direction: 'inbound', body: 'quero agendar' }] });
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.agendamento, motivo: 'Pedido de agendamento.', evidencias: [M1] },
    }));
    await executarRevisao(d, ORG, REVISAO);
    const acoesDepoisDaPrimeira = banco.acoes.size;
    const segunda = await executarRevisao(d, ORG, REVISAO);

    expect(segunda).toEqual({ tipo: 'reaproveitada', status: 'concluida', codigo: 'EXE' });
    expect(d.chamadas()).toBe(1);
    expect(banco.escritasDeEtapa).toBe(1);
    expect(banco.acoes.size).toBe(acoesDepoisDaPrimeira);
  });
});

describe('alteração humana entre a leitura e a escrita', () => {
  it('preserva a decisão da pessoa: a trava recusa, a releitura vê a mudança e registra BLOQ', async () => {
    const banco = new BancoFalso({ etapa: E.aguardandoSinal, mensagens: [{ id: M2, direction: 'inbound', body: 'comprovante' }] });
    banco.antesDaEscrita = () => {
      banco.lead = { ...banco.lead, stage_id: E.consultaAgendada, status: 'won', stage_changed_at: '2026-09-16T13:05:00.000Z' };
      banco.mudancasHumanas.push({ activity_id: 'ab000000-0000-4000-8000-000000000001', performed_at: '2026-09-16T13:05:00.000Z' });
    };
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.comprovante, motivo: 'Comprovante enviado.', evidencias: [M2] },
    }));
    await executarRevisao(d, ORG, REVISAO);

    expect(banco.lead.stage_id).toBe(E.consultaAgendada);
    expect(banco.escritasDeEtapa).toBe(0);
    expect([...banco.acoes.values()].map((a) => a.code)).toEqual(['BLOQ']);
    expect(d.chamadas()).toBe(1);
  });
});

describe('queda depois do commit da movimentação', () => {
  it('a retentativa reaproveita a proposta, reconhece a escrita feita e não move de novo', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo, mensagens: [{ id: M1, direction: 'inbound', body: 'quero agendar' }] });
    banco.falharAoFinalizar = true;
    const d = deps(banco, proposta({
      movimentacao: { para_etapa_id: E.agendamento, motivo: 'Pedido de agendamento.', evidencias: [M1] },
    }));

    await expect(executarRevisao(d, ORG, REVISAO)).rejects.toThrow('queda simulada');
    expect(banco.revisao.status).toBe('em_execucao');
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ tipo: 'concluida', codigo: 'EXE' });
    expect(d.chamadas()).toBe(1);
    expect(banco.escritasDeEtapa).toBe(1);
    expect(banco.atividadesDeMovimento).toHaveLength(1);
  });
});

describe('respostas e filtros que nunca viram revisão aprovada', () => {
  it('texto fora do formato é BLOQ visível, não "nada a fazer"', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo });
    const r = await executarRevisao(deps(banco, 'Tudo certo com esta conversa!'), ORG, REVISAO);

    expect(r).toMatchObject({ status: 'bloqueada', codigo: 'BLOQ' });
    expect(banco.pendencias).toHaveLength(1);
    expect(banco.escritasDeEtapa).toBe(0);
  });

  it('ação de pessoa sem vínculo com a equipe é revisão bloqueada, sem chamar o modelo', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo, ator: { tipo: 'user', id: '99999999-0000-4000-8000-000000000000' } });
    const d = deps(banco, proposta({}));
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ status: 'bloqueada', codigo: 'BLOQ' });
    expect(d.chamadas()).toBe(0);
  });

  it('vínculo desligado entre o enfileiramento e a execução: encerra sem pendência e sem modelo', async () => {
    const banco = new BancoFalso({ etapa: E.entendendo });
    banco.vinculo = { ...VINCULO_DA_CLINICA, enabled: false };
    const d = deps(banco, proposta({}));
    const r = await executarRevisao(d, ORG, REVISAO);

    expect(r).toMatchObject({ status: 'bloqueada', codigo: null });
    expect(banco.pendencias).toHaveLength(0);
    expect(d.chamadas()).toBe(0);
  });
});

describe('nenhum envio externo', () => {
  it('os contratos do executor não oferecem canal, agenda nem pagamento', () => {
    const banco = new BancoFalso({ etapa: E.entendendo });
    const capacidades = [
      ...Object.getOwnPropertyNames(BancoFalso.prototype),
      ...Object.keys(deps(banco, {})),
    ].join(' ').toLowerCase();
    for (const proibida of ['send', 'enviar', 'whatsapp', 'channel', 'canal', 'appointment', 'agendar', 'pagamento', 'payment']) {
      expect(capacidades, `capacidade proibida exposta: ${proibida}`).not.toContain(proibida);
    }
  });
});
