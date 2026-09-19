/**
 * Supervisão de agente — o EXECUTOR da revisão.
 *
 * Orquestra, contra uma interface de banco ESTREITA (`SupervisaoDb`), o que as
 * funções puras de `politica.ts` decidiram. Estreita de propósito, no mesmo
 * padrão de `lib/followup/engine.ts` e `reactivity.ts`: o executor fica testável
 * com um banco em memória que simula reentrega e escrita concorrente, e o
 * adaptador pg (`db-pg.ts`) é o único lugar que conhece SQL.
 *
 * ═══ AS GARANTIAS, e onde cada uma mora ═══
 *
 * - IDEMPOTÊNCIA: a revisão é uma linha com chave única. Revisão em estado
 *   terminal devolve o resultado gravado e sai (`reaproveitada`). Cada ação tem
 *   chave própria; ação já `executada` nunca é refeita numa retentativa.
 * - RETENTATIVA NÃO MUDA A DECISÃO: a proposta do modelo é gravada na primeira
 *   leitura válida e reaproveitada. Chamar o modelo de novo poderia produzir
 *   outra proposta e outras ações, e a ação da primeira tentativa ficaria órfã.
 * - ESTADO ATUAL: tudo é decidido sobre `lerEstado`, feito AGORA. O conteúdo do
 *   evento só aponta; não substitui a leitura.
 * - CONCORRÊNCIA: a mudança de etapa é uma escrita condicional (etapa esperada +
 *   carimbo da última mudança + revisão da conversa). Recusada, relê, recalcula
 *   UMA vez sobre a mesma proposta e, recusada de novo, registra BLOQ
 *   `conflito_de_estado` — nunca sobrescreve. A serialização por conversa vem da
 *   fila: `supervisor_review` roda na lane do contato.
 * - EXE COM PROVA: só a ferramenta concluída com sucesso marca `executada`; o
 *   CHECK da 0265 recusa EXE sem referência de resultado.
 * - SEM CANAL: nada aqui envia mensagem. O executor não recebe adaptador de
 *   canal, e o adaptador pg não tem função de envio.
 */
import {
  STATUS_TERMINAIS,
  VERSAO_DO_ENQUADRAMENTO,
  chaveDaAcao,
  eventoDeRevisaoSchema,
  type CodigoDeResultado,
  type EventoDeRevisao,
  type StatusDaRevisao,
} from './contrato';
import {
  avaliarProposta,
  codigoDaRevisao,
  decidirAcionamento,
  resumoDoEstadoParaRegistro,
  type AcaoDecidida,
  type EstadoLido,
  type MotivoDeBloqueio,
  type StatusFinalDaAcao,
  type VinculoDeSupervisao,
  type VinculoDoUsuario,
} from './politica';
import {
  lerPropostaDoSupervisor,
  propostaDoSupervisorSchema,
  type PropostaDoSupervisor,
} from './proposta';

// ─── contrato com o banco ────────────────────────────────────────────────────

export interface RevisaoRow extends EventoDeRevisao {
  id: string;
  binding_id: string;
  idempotency_key: string;
  supervisor_agent_id: string;
  status: StatusDaRevisao;
  outcome_code: CodigoDeResultado | null;
  policy_version: string;
  proposal: unknown;
  exit_reason: string | null;
  attempts: number;
}

export interface AcaoRow {
  id: string;
  action_key: string;
  kind: 'mover_etapa' | 'registrar_pendencia';
  expected_stage_id: string | null;
  status: 'pendente' | StatusFinalDaAcao;
  code: CodigoDeResultado | null;
  tool_result_ref: string | null;
}

export type ResultadoDaMovimentacao =
  | { ok: true; ref: string }
  | { ok: false; porque: 'conflito' | 'autorizacao_revogada' };

export interface SupervisaoDb {
  carregarRevisao(orgId: string, reviewId: string): Promise<RevisaoRow | null>;
  /**
   * `pendente`/`em_execucao`/`falhou` → `em_execucao`, `attempts + 1`.
   * Devolve `null` se a revisão já está terminal (outro worker concluiu).
   */
  iniciarRevisao(orgId: string, reviewId: string): Promise<RevisaoRow | null>;
  carregarVinculo(orgId: string, bindingId: string): Promise<VinculoDeSupervisao | null>;
  supervisoresDaOrganizacao(orgId: string): Promise<Set<string>>;
  vinculoDoUsuario(orgId: string, userId: string): Promise<VinculoDoUsuario>;
  lerEstado(revisao: RevisaoRow): Promise<EstadoLido>;
  gravarProposta(orgId: string, reviewId: string, proposta: PropostaDoSupervisor, promptVersion: string): Promise<void>;
  carregarAcao(orgId: string, actionKey: string): Promise<AcaoRow | null>;
  /** Insere a ação pela chave; se já existe, devolve a existente sem alterar. */
  registrarAcao(input: {
    organization_id: string;
    review_id: string;
    action_key: string;
    kind: 'mover_etapa' | 'registrar_pendencia';
    expected_stage_id: string | null;
    target_stage_id: string | null;
    evidence_ids: string[];
    reason: string;
    next_owner: string | null;
  }): Promise<AcaoRow>;
  finalizarAcao(
    orgId: string,
    actionId: string,
    patch: { status: StatusFinalDaAcao; code: CodigoDeResultado; tool_result_ref: string | null; reason?: string },
  ): Promise<void>;
  /**
   * Escrita CONDICIONAL: só move se etapa, carimbo da última mudança e revisão
   * da conversa continuam os lidos. Registra a atividade e o evento na mesma
   * transação, com metadata que marca a origem como supervisão (anti-ciclo).
   * IDEMPOTENTE pela `action_key`: se a transação de uma tentativa anterior já
   * commitou, devolve `ok` com a mesma referência em vez de acusar conflito.
   * Lança em falha técnica — a fila tenta de novo com a revisão em execução.
   */
  moverEtapaComTrava(input: {
    /** Só reencontra recibo; nunca faz movimento novo na recuperação. */
    somente_recuperar?: boolean;
    organization_id: string;
    lead_id: string;
    contact_id: string;
    conversation_id: string;
    de_etapa_id: string;
    para_etapa_id: string;
    stage_changed_at_esperado: string | null;
    service_revision_esperada: string | null;
    review_id: string;
    action_key: string;
    supervisor_agent_id: string;
    trace_id: string;
    motivo: string;
  }): Promise<ResultadoDaMovimentacao>;
  /** Abre (ou reencontra, pela chave da ação) a pendência na Central. Devolve o id. */
  abrirPendencia(input: {
    organization_id: string;
    conversation_id: string;
    action_key: string;
    titulo: string;
    corpo: string;
  }): Promise<{ ref: string }>;
  concluirRevisao(
    orgId: string,
    reviewId: string,
    patch: {
      status: Extract<StatusDaRevisao, 'concluida' | 'bloqueada' | 'falhou'>;
      outcome_code: CodigoDeResultado | null;
      state_read: Record<string, unknown> | null;
      stage_before_id: string | null;
      stage_recommended_id: string | null;
      exit_reason: string | null;
      human_validator_user_id?: string | null;
    },
  ): Promise<void>;
  /** Linha na timeline do negócio. Best-effort: falha não derruba a revisão. */
  registrarAtividade(input: {
    organization_id: string;
    lead_id: string;
    contact_id: string;
    review_id: string;
    supervisor_agent_id: string;
    trace_id: string;
    codigo: CodigoDeResultado | null;
    contagem: Record<CodigoDeResultado, number>;
  }): Promise<void>;
}

export interface SupervisorPublicado {
  agentId: string;
  versionId: string;
  politicas: string;
}

export interface SupervisaoDeps {
  db: SupervisaoDb;
  carregarSupervisor(orgId: string, agentId: string): Promise<SupervisorPublicado | null>;
  /** A única chamada de modelo. Devolve o texto cru — quem valida é `lerPropostaDoSupervisor`. */
  proporRevisao(input: {
    revisao: RevisaoRow;
    vinculo: VinculoDeSupervisao;
    estado: EstadoLido;
    supervisor: SupervisorPublicado;
  }): Promise<string>;
  log?: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
}

export type DesfechoDaExecucao =
  | { tipo: 'reaproveitada'; status: StatusDaRevisao; codigo: CodigoDeResultado | null }
  | { tipo: 'nao_encontrada' }
  | { tipo: 'concluida'; status: 'concluida' | 'bloqueada'; codigo: CodigoDeResultado | null; acoes: StatusFinalDaAcao[] };

// ─── execução ────────────────────────────────────────────────────────────────

export async function executarRevisao(
  deps: SupervisaoDeps,
  orgId: string,
  reviewId: string,
): Promise<DesfechoDaExecucao> {
  const { db } = deps;
  const existente = await db.carregarRevisao(orgId, reviewId);
  if (existente === null) return { tipo: 'nao_encontrada' };
  if (STATUS_TERMINAIS.includes(existente.status)) {
    // Reentrega do mesmo evento: devolve o que já foi decidido. Nada se repete.
    return { tipo: 'reaproveitada', status: existente.status, codigo: existente.outcome_code };
  }

  const revisao = await db.iniciarRevisao(orgId, reviewId);
  if (revisao === null) {
    const agora = await db.carregarRevisao(orgId, reviewId);
    return { tipo: 'reaproveitada', status: agora?.status ?? 'concluida', codigo: agora?.outcome_code ?? null };
  }

  // O evento gravado é revalidado: a linha veio do banco, mas foi montada por
  // quem enfileirou, e um contrato quebrado não pode virar revisão "normal".
  const evento = eventoDeRevisaoSchema.safeParse(eventoDaRevisao(revisao));
  if (!evento.success) return bloquearRevisao(db, revisao, 'falha_tecnica', null);

  const vinculo = await db.carregarVinculo(orgId, revisao.binding_id);
  if (vinculo === null) return bloquearRevisao(db, revisao, 'vinculo_desligado', null);

  // O filtro roda DE NOVO aqui: o vínculo pode ter sido desligado, e o vínculo
  // da pessoa revogado, entre o enfileiramento e a execução.
  const acionamento = decidirAcionamento(evento.data, vinculo, {
    supervisoresDaOrganizacao: await db.supervisoresDaOrganizacao(orgId),
    vinculoDoUsuario: revisao.actor_type === 'user' ? await db.vinculoDoUsuario(orgId, revisao.actor_id) : null,
    originadoPorSupervisao: false,
  });
  if (!acionamento.aciona) {
    return bloquearRevisao(db, revisao, 'vinculo_desligado', null, acionamento.porque);
  }
  if (acionamento.bloqueada) return bloquearRevisao(db, revisao, acionamento.porque, null);

  let estado = await db.lerEstado(revisao);
  if (estado.lead === null) return bloquearRevisao(db, revisao, 'sem_negocio_no_funil', estado);

  // ── a proposta: reaproveitada em retentativa, pedida ao modelo na primeira ──
  let proposta: PropostaDoSupervisor;
  let retentativa = false;
  const gravada = revisao.proposal === null ? null : propostaDoSupervisorSchema.safeParse(revisao.proposal);
  if (gravada !== null && gravada.success) {
    proposta = gravada.data;
    retentativa = true;
  } else {
    const supervisor = await deps.carregarSupervisor(orgId, revisao.supervisor_agent_id);
    if (supervisor === null) return bloquearRevisao(db, revisao, 'supervisor_indisponivel', estado);
    const texto = await deps.proporRevisao({ revisao, vinculo, estado, supervisor });
    const lida = lerPropostaDoSupervisor(texto);
    if (!lida.ok) {
      return bloquearRevisao(db, revisao, 'resposta_do_supervisor_invalida', estado, lida.porque);
    }
    proposta = lida.proposta;
    await db.gravarProposta(orgId, revisao.id, proposta, `${VERSAO_DO_ENQUADRAMENTO}:${supervisor.versionId}`);
  }

  const etapaAntes = estado.lead.stage_id;
  const finais: StatusFinalDaAcao[] = [];
  const tratadas = new Set<string>();
  let recomendada: string | null = null;

  // RETENTATIVA DEPOIS DE UMA QUEDA: a transação da movimentação pode ter
  // commitado sem que o desfecho da ação tenha sido gravado. Nesse caso o card
  // JÁ está na etapa pretendida, e reavaliar a proposta daria "já está lá" —
  // nenhuma ação, e a EXE real ficaria para sempre `pendente`. A escrita é
  // idempotente pela chave da ação: pedi-la de novo devolve a MESMA referência
  // quando foi nossa, e conflito quando outra mão levou o card até lá.
  if (retentativa && proposta.movimentacao !== null) {
    const chave = chaveDaAcao(revisao.id, 'mover_etapa', proposta.movimentacao.para_etapa_id);
    const anterior = await db.carregarAcao(orgId, chave);
    if (
      anterior !== null &&
      (anterior.status === 'pendente' || anterior.status === 'falhou') &&
      estado.lead.stage_id === proposta.movimentacao.para_etapa_id
    ) {
      const r = await db.moverEtapaComTrava({
        somente_recuperar: true,
        organization_id: orgId,
        lead_id: estado.lead.id,
        contact_id: revisao.contact_id,
        conversation_id: revisao.conversation_id,
        de_etapa_id: anterior.expected_stage_id ?? estado.lead.stage_id,
        para_etapa_id: proposta.movimentacao.para_etapa_id,
        stage_changed_at_esperado: estado.lead.stage_changed_at,
        service_revision_esperada: estado.conversa.service_revision,
        review_id: revisao.id,
        action_key: chave,
        supervisor_agent_id: revisao.supervisor_agent_id,
        trace_id: revisao.trace_id,
        motivo: proposta.movimentacao.motivo,
      });
      if (r.ok) {
        await db.finalizarAcao(orgId, anterior.id, { status: 'executada', code: 'EXE', tool_result_ref: r.ref });
        finais.push('executada');
        recomendada = proposta.movimentacao.para_etapa_id;
      } else {
        // Outra mão levou o card à mesma etapa: não é nossa EXE e não há o que
        // sobrescrever. Fecha a ação sem abrir pendência — nada ficou por decidir.
        await db.finalizarAcao(orgId, anterior.id, {
          status: 'bloqueada',
          code: 'BLOQ',
          tool_result_ref: null,
          reason: 'conflito_de_estado: a etapa pretendida foi alcançada por outra mão',
        });
      }
      tratadas.add(chave);
    }
  }

  const decididas = avaliarProposta(proposta, estado, vinculo);

  for (const [indice, decidida] of decididas.entries()) {
    const acaoKey = chaveDaAcao(
      revisao.id,
      decidida.kind,
      decidida.kind === 'mover_etapa' ? decidida.para_etapa_id : String(indice),
    );
    if (tratadas.has(acaoKey)) continue;
    const registro = await db.registrarAcao({
      organization_id: orgId,
      review_id: revisao.id,
      action_key: acaoKey,
      kind: decidida.kind,
      expected_stage_id: decidida.kind === 'mover_etapa' ? decidida.de_etapa_id : null,
      target_stage_id: decidida.kind === 'mover_etapa' ? decidida.para_etapa_id : null,
      evidence_ids: decidida.evidencias,
      reason: decidida.motivo,
      next_owner: decidida.kind === 'registrar_pendencia' ? decidida.responsavel : null,
    });
    if (registro.status !== 'pendente' && registro.status !== 'falhou') {
      // Concluída numa tentativa anterior. Conta para o código, não se repete.
      finais.push(registro.status);
      continue;
    }
    if (decidida.kind === 'mover_etapa') recomendada = decidida.para_etapa_id;

    const resultado = await aplicarAcao(deps, revisao, estado, decidida, registro, acaoKey, vinculo, proposta);
    estado = resultado.estado;
    finais.push(resultado.status);
  }

  const codigo = codigoDaRevisao(finais);
  const contagem: Record<CodigoDeResultado, number> = { EXE: 0, RECOM: 0, BLOQ: 0 };
  for (const s of finais) contagem[s === 'executada' ? 'EXE' : s === 'recomendada' ? 'RECOM' : 'BLOQ'] += 1;

  const status = codigo === 'BLOQ' ? 'bloqueada' : 'concluida';
  await db.concluirRevisao(orgId, revisao.id, {
    status,
    outcome_code: codigo,
    state_read: resumoDoEstadoParaRegistro(estado),
    stage_before_id: etapaAntes,
    stage_recommended_id: recomendada,
    exit_reason: finais.length === 0 ? 'nada_a_fazer' : null,
    // Ação humana só chega aqui com vínculo VALIDADO (o filtro acima bloqueia o
    // resto) — é esse o "responsável humano validado" do registro.
    human_validator_user_id: revisao.actor_type === 'user' ? revisao.actor_id : null,
  });
  if (estado.lead !== null && finais.length > 0) {
    try {
      await db.registrarAtividade({
        organization_id: orgId,
        lead_id: estado.lead.id,
        contact_id: revisao.contact_id,
        review_id: revisao.id,
        supervisor_agent_id: revisao.supervisor_agent_id,
        trace_id: revisao.trace_id,
        codigo,
        contagem,
      });
    } catch (err) {
      deps.log?.warn('linha da revisão na timeline não foi gravada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }
  return { tipo: 'concluida', status, codigo, acoes: finais };
}

async function aplicarAcao(
  deps: SupervisaoDeps,
  revisao: RevisaoRow,
  estado: EstadoLido,
  decidida: AcaoDecidida,
  registro: AcaoRow,
  acaoKey: string,
  vinculo: VinculoDeSupervisao,
  proposta: PropostaDoSupervisor,
): Promise<{ status: StatusFinalDaAcao; estado: EstadoLido }> {
  const { db } = deps;
  const orgId = revisao.organization_id;

  if (decidida.decisao === 'bloquear') {
    const pend = await db.abrirPendencia({
      organization_id: orgId,
      conversation_id: revisao.conversation_id,
      action_key: acaoKey,
      titulo: 'A supervisão não pôde concluir uma ação',
      corpo: textoDoBloqueio(decidida.porque),
    });
    await db.finalizarAcao(orgId, registro.id, { status: 'bloqueada', code: 'BLOQ', tool_result_ref: pend.ref, reason: `${decidida.porque}: ${decidida.motivo}` });
    return { status: 'bloqueada', estado };
  }

  if (decidida.decisao === 'recomendar') {
    const pend = await db.abrirPendencia({
      organization_id: orgId,
      conversation_id: revisao.conversation_id,
      action_key: acaoKey,
      titulo:
        decidida.kind === 'mover_etapa'
          ? 'A supervisão recomenda mudar a etapa deste negócio'
          : 'A supervisão deixou uma pendência para a equipe',
      corpo: `${textoDaRecomendacao(decidida.porque)} Motivo: ${decidida.motivo}`,
    });
    await db.finalizarAcao(orgId, registro.id, { status: 'recomendada', code: 'RECOM', tool_result_ref: pend.ref });
    return { status: 'recomendada', estado };
  }

  // decisao === 'executar' — a única que escreve no funil.
  let atual = estado;
  let tentativa = decidida;
  for (let rodada = 0; rodada < 2; rodada += 1) {
    const lead = atual.lead!;
    const r = await db.moverEtapaComTrava({
      organization_id: orgId,
      lead_id: lead.id,
      contact_id: revisao.contact_id,
      conversation_id: revisao.conversation_id,
      de_etapa_id: tentativa.de_etapa_id,
      para_etapa_id: tentativa.para_etapa_id,
      stage_changed_at_esperado: lead.stage_changed_at,
      service_revision_esperada: atual.conversa.service_revision,
      review_id: revisao.id,
      action_key: acaoKey,
      supervisor_agent_id: revisao.supervisor_agent_id,
      trace_id: revisao.trace_id,
      motivo: tentativa.motivo,
    });
    if (r.ok) {
      await db.finalizarAcao(orgId, registro.id, { status: 'executada', code: 'EXE', tool_result_ref: r.ref });
      return { status: 'executada', estado: atual };
    }
    if (r.porque === 'autorizacao_revogada') {
      await db.finalizarAcao(orgId, registro.id, {
        status: 'bloqueada', code: 'BLOQ', tool_result_ref: null,
        reason: 'A autorização mudou durante a revisão; nenhuma mudança foi realizada.',
      });
      return { status: 'bloqueada', estado: atual };
    }
    // Recusada pela trava: alguém mudou o registro entre a leitura e a escrita.
    // Relê e recalcula SOBRE A MESMA PROPOSTA — sem nova chamada de modelo.
    atual = await db.lerEstado(revisao);
    const refeita = avaliarProposta(proposta, atual, vinculo).find((a) => a.kind === 'mover_etapa');
    if (refeita === undefined || refeita.kind !== 'mover_etapa') {
      // Na releitura já não há o que mover (ex.: a pessoa levou o card para a
      // etapa pretendida). Não é conflito a registrar como erro, mas também não
      // é EXE: registra-se o bloqueio com o motivo real.
      break;
    }
    if (refeita.decisao !== 'executar') {
      return aplicarAcao(deps, revisao, atual, refeita, registro, acaoKey, vinculo, proposta);
    }
    tentativa = refeita;
  }
  const pend = await db.abrirPendencia({
    organization_id: orgId,
    conversation_id: revisao.conversation_id,
    action_key: acaoKey,
    titulo: 'A supervisão não pôde concluir uma ação',
    corpo: textoDoBloqueio('conflito_de_estado'),
  });
  await db.finalizarAcao(orgId, registro.id, { status: 'bloqueada', code: 'BLOQ', tool_result_ref: pend.ref, reason: 'conflito_de_estado' });
  return { status: 'bloqueada', estado: atual };
}

async function bloquearRevisao(
  db: SupervisaoDb,
  revisao: RevisaoRow,
  porque: MotivoDeBloqueio,
  estado: EstadoLido | null,
  detalhe?: string,
): Promise<DesfechoDaExecucao> {
  const acaoKey = chaveDaAcao(revisao.id, 'registrar_pendencia', `bloqueio:${porque}`);
  // Filtro silencioso na execução (vínculo desligado depois de enfileirar) não
  // abre pendência: ninguém precisa decidir nada, só fica registrado.
  const abrePendencia = porque !== 'vinculo_desligado';
  if (abrePendencia) {
    const registro = await db.registrarAcao({
      organization_id: revisao.organization_id,
      review_id: revisao.id,
      action_key: acaoKey,
      kind: 'registrar_pendencia',
      expected_stage_id: null,
      target_stage_id: null,
      evidence_ids: [],
      reason: detalhe === undefined ? porque : `${porque}: ${detalhe}`,
      next_owner: 'equipe',
    });
    if (registro.status === 'pendente' || registro.status === 'falhou') {
      const pend = await db.abrirPendencia({
        organization_id: revisao.organization_id,
        conversation_id: revisao.conversation_id,
        action_key: acaoKey,
        titulo: 'A supervisão não pôde revisar esta conversa',
        corpo: textoDoBloqueio(porque),
      });
      await db.finalizarAcao(revisao.organization_id, registro.id, { status: 'bloqueada', code: 'BLOQ', tool_result_ref: pend.ref });
    }
  }
  await db.concluirRevisao(revisao.organization_id, revisao.id, {
    status: 'bloqueada',
    outcome_code: abrePendencia ? 'BLOQ' : null,
    state_read: estado === null ? null : resumoDoEstadoParaRegistro(estado),
    stage_before_id: estado?.lead?.stage_id ?? null,
    stage_recommended_id: null,
    exit_reason: detalhe === undefined ? porque : `${porque}:${detalhe}`,
  });
  return { tipo: 'concluida', status: 'bloqueada', codigo: abrePendencia ? 'BLOQ' : null, acoes: abrePendencia ? ['bloqueada'] : [] };
}

function eventoDaRevisao(r: RevisaoRow): EventoDeRevisao {
  return {
    event_id: r.event_id,
    organization_id: r.organization_id,
    conversation_id: r.conversation_id,
    contact_id: r.contact_id,
    lead_id: r.lead_id,
    pipeline_id: r.pipeline_id,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    occurred_at: r.occurred_at,
    conversation_revision: r.conversation_revision,
    origin: r.origin,
    trace_id: r.trace_id,
  };
}

/** Frases para quem lê a Central — consequência de negócio, sem jargão. */
export function textoDoBloqueio(porque: MotivoDeBloqueio): string {
  const textos: Record<MotivoDeBloqueio, string> = {
    usuario_sem_vinculo: 'A ação revisada foi feita por alguém sem vínculo ativo com a equipe. Confira quem atendeu esta conversa.',
    vinculo_do_usuario_ambiguo: 'Não foi possível confirmar quem da equipe fez a ação revisada. Confira o atendimento.',
    vinculo_desligado: 'A supervisão desta conversa foi desligada antes da revisão.',
    supervisor_indisponivel: 'O agente supervisor não está publicado ou não pôde ser carregado. Nenhuma revisão foi feita.',
    sem_negocio_no_funil: 'Esta conversa não tem negócio no funil supervisionado. Confira se o contato precisa entrar no funil.',
    negocio_encerrado: 'O negócio já está encerrado. A supervisão não altera negócios fechados.',
    contato_anonimizado: 'O contato foi anonimizado. A supervisão não altera registros anonimizados.',
    resposta_do_supervisor_invalida: 'O supervisor devolveu uma resposta fora do formato. Nada foi alterado; a conversa precisa de revisão da equipe.',
    etapa_inexistente_no_funil: 'O supervisor apontou uma etapa que não existe neste funil. Nada foi alterado.',
    etapa_exige_confirmacao_humana: 'A mudança sugerida leva a uma etapa que só a equipe confirma (agendamento ou perda). Nada foi alterado.',
    evidencia_insuficiente: 'A mudança sugerida não tinha mensagem da conversa que a sustentasse. Nada foi alterado.',
    conflito_de_estado: 'O negócio mudou enquanto a revisão acontecia. A mudança mais recente foi preservada e nada foi sobrescrito.',
    falha_tecnica: 'A revisão não pôde ser concluída por uma falha técnica. Nada foi alterado.',
  };
  return textos[porque];
}

function textoDaRecomendacao(porque: string): string {
  switch (porque) {
    case 'modo_recomendar':
      return 'A supervisão está configurada para só recomendar.';
    case 'transicao_nao_autorizada':
      return 'Esta mudança de etapa não está entre as que a supervisão pode fazer sozinha.';
    case 'revisao_humana_necessaria':
      return 'O assunto precisa de conferência da equipe antes de qualquer mudança.';
    case 'atendimento_humano_em_curso':
      return 'Uma pessoa da equipe está com este atendimento; a mudança fica para ela decidir.';
    default:
      return 'Ponto para a equipe conferir.';
  }
}
