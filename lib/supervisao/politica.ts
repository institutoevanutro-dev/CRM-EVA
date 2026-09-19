/**
 * Supervisão de agente — as DECISÕES, todas puras.
 *
 * Nada aqui toca banco, fila ou modelo. É o que decide se um fato vira revisão,
 * se a revisão pode agir e com qual código o resultado é registrado. Ficar puro
 * é o que permite provar os seis critérios de aceitação sem worker, sem banco e
 * sem chave de LLM — e provar separadamente que a FIAÇÃO (executor) respeita
 * cada decisão.
 *
 * A regra que atravessa o arquivo: o modelo SUGERE, o código AUTORIZA. Nenhuma
 * frase do modelo move card, confirma pagamento, cria agendamento, marca falta
 * ou classifica perda. O que ele devolve é uma proposta com evidência; o que
 * acontece é decidido aqui, contra a configuração e contra o estado lido agora.
 */
import type { CodigoDeResultado, EventoDeRevisao } from './contrato';
import type { PropostaDoSupervisor } from './proposta';

// ─── configuração ───────────────────────────────────────────────────────────

export interface TransicaoAutorizada {
  to_stage_id: string;
  /** Vazio = a partir de qualquer etapa aberta. */
  from_stage_ids: string[];
}

export interface VinculoDeSupervisao {
  id: string;
  organization_id: string;
  supervisor_agent_id: string;
  supervised_agent_id: string;
  pipeline_id: string;
  enabled: boolean;
  review_human_actions: boolean;
  mode: 'recomendar' | 'executar';
  allowed_stage_moves: TransicaoAutorizada[];
  policy_version: string;
}

// ─── 1. o fato vira revisão? ─────────────────────────────────────────────────

export type VinculoDoUsuario = 'valido' | 'ausente' | 'ambiguo';

export type DecisaoDeAcionamento =
  /** Fora do escopo do vínculo: não é erro e não gera linha de revisão. */
  | { aciona: false; porque: FiltroSilencioso }
  /** Dentro do escopo, mas sem condição de revisar com segurança: gera revisão BLOQ. */
  | { aciona: true; bloqueada: true; porque: MotivoDeBloqueio }
  | { aciona: true; bloqueada: false };

export type FiltroSilencioso =
  | 'vinculo_desligado'
  | 'outra_organizacao'
  | 'outro_funil'
  | 'agente_nao_supervisionado'
  | 'acoes_humanas_fora_do_escopo'
  | 'ciclo_do_supervisor';

/**
 * Filtra o evento contra UM vínculo. Chamado por quem enfileira E de novo por
 * quem executa — o vínculo pode ter sido desligado entre os dois instantes.
 *
 * `supervisoresDaOrganizacao`: todo agente que é supervisor em QUALQUER vínculo
 * da organização. É o que corta o ciclo sem depender de marcação no evento: a
 * execução de um supervisor nunca aciona supervisão, nem a de outro supervisor.
 */
export function decidirAcionamento(
  evento: EventoDeRevisao,
  vinculo: VinculoDeSupervisao,
  contexto: {
    supervisoresDaOrganizacao: ReadonlySet<string>;
    /** Só consultado para ator humano. */
    vinculoDoUsuario: VinculoDoUsuario | null;
    /** O fato foi produzido por uma revisão de supervisão (metadata do evento). */
    originadoPorSupervisao: boolean;
  },
): DecisaoDeAcionamento {
  if (!vinculo.enabled) return { aciona: false, porque: 'vinculo_desligado' };
  if (evento.organization_id !== vinculo.organization_id) {
    return { aciona: false, porque: 'outra_organizacao' };
  }
  if (evento.pipeline_id !== vinculo.pipeline_id) return { aciona: false, porque: 'outro_funil' };

  // Anti-ciclo ANTES de qualquer outro filtro de ator: a conclusão de uma
  // revisão move card e emite `lead.stage_changed` — se isso chegasse ao filtro
  // humano, a revisão geraria a revisão de si mesma.
  if (contexto.originadoPorSupervisao) return { aciona: false, porque: 'ciclo_do_supervisor' };
  if (evento.actor_type === 'ai_agent' && contexto.supervisoresDaOrganizacao.has(evento.actor_id)) {
    return { aciona: false, porque: 'ciclo_do_supervisor' };
  }

  if (evento.actor_type === 'ai_agent') {
    if (evento.actor_id !== vinculo.supervised_agent_id) {
      return { aciona: false, porque: 'agente_nao_supervisionado' };
    }
    return { aciona: true, bloqueada: false };
  }

  if (!vinculo.review_human_actions) return { aciona: false, porque: 'acoes_humanas_fora_do_escopo' };
  // Pessoa sem vínculo ativo com a organização, ou vínculo que não dá para
  // afirmar: a revisão EXISTE (o fato aconteceu na conversa) mas não pode agir.
  if (contexto.vinculoDoUsuario !== 'valido') {
    return {
      aciona: true,
      bloqueada: true,
      porque: contexto.vinculoDoUsuario === 'ambiguo' ? 'vinculo_do_usuario_ambiguo' : 'usuario_sem_vinculo',
    };
  }
  return { aciona: true, bloqueada: false };
}

// ─── 2. o estado lido agora ──────────────────────────────────────────────────

export interface EtapaLida {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
  is_archived: boolean;
  requires_human: boolean;
  blocks_followups: boolean;
}

export interface MensagemLida {
  id: string;
  direction: 'inbound' | 'outbound';
  sent_via: string;
  sent_by_user_id: string | null;
  type: string;
  created_at: string;
  /** Só para o modelo. NUNCA vai para o registro. */
  body: string | null;
}

export interface EstadoLido {
  lida_em: string;
  lead: {
    id: string;
    pipeline_id: string;
    stage_id: string;
    status: string;
    stage_changed_at: string | null;
    owner_kind: string | null;
    owner_user_id: string | null;
  } | null;
  contato: { is_blocked: boolean; force_human: boolean; is_anonymized: boolean };
  conversa: {
    id: string;
    service_revision: string | null;
    assigned_to_user_id: string | null;
    em_atendimento_humano: boolean;
  };
  etapas: EtapaLida[];
  mensagens: MensagemLida[];
  /** Mudança de etapa feita por PESSOA depois do fato revisado. */
  mudancas_humanas_de_etapa_apos_evento: Array<{ activity_id: string; performed_at: string }>;
  /** Mensagens enviadas por PESSOA depois do fato revisado. */
  mensagens_humanas_apos_evento: string[];
  agendamentos_futuros: Array<{ id: string; status: string; starts_at: string }>;
  followups_vivos: Array<{ id: string; status: string; pointer_id: string }>;
}

/**
 * O que vai para `ai_supervision_reviews.state_read`: só ids, etapas e flags.
 * Corpo de mensagem, nome de pessoa e qualquer texto clínico ficam de fora.
 */
export function resumoDoEstadoParaRegistro(estado: EstadoLido): Record<string, unknown> {
  return {
    lida_em: estado.lida_em,
    lead: estado.lead === null
      ? null
      : {
          id: estado.lead.id,
          stage_id: estado.lead.stage_id,
          status: estado.lead.status,
          stage_changed_at: estado.lead.stage_changed_at,
          owner_kind: estado.lead.owner_kind,
        },
    contato: estado.contato,
    conversa: {
      id: estado.conversa.id,
      service_revision: estado.conversa.service_revision,
      em_atendimento_humano: estado.conversa.em_atendimento_humano,
    },
    mensagens_ids: estado.mensagens.map((m) => m.id),
    mudancas_humanas_de_etapa_apos_evento: estado.mudancas_humanas_de_etapa_apos_evento.map((m) => m.activity_id),
    mensagens_humanas_apos_evento: estado.mensagens_humanas_apos_evento,
    agendamentos_futuros: estado.agendamentos_futuros.map((a) => ({ id: a.id, status: a.status })),
    followups_vivos: estado.followups_vivos.map((f) => ({ id: f.id, status: f.status })),
  };
}

// ─── 3. a proposta vira ação? ────────────────────────────────────────────────

export type MotivoDeBloqueio =
  | 'usuario_sem_vinculo'
  | 'vinculo_do_usuario_ambiguo'
  | 'vinculo_desligado'
  | 'supervisor_indisponivel'
  | 'sem_negocio_no_funil'
  | 'negocio_encerrado'
  | 'contato_anonimizado'
  | 'resposta_do_supervisor_invalida'
  | 'etapa_inexistente_no_funil'
  | 'etapa_exige_confirmacao_humana'
  | 'evidencia_insuficiente'
  | 'conflito_de_estado'
  | 'falha_tecnica';

export type MotivoDeRecomendacao =
  | 'modo_recomendar'
  | 'transicao_nao_autorizada'
  | 'revisao_humana_necessaria'
  | 'atendimento_humano_em_curso'
  | 'pendencia_para_equipe';

export type AcaoDecidida =
  | {
      kind: 'mover_etapa';
      decisao: 'executar';
      code: 'EXE';
      de_etapa_id: string;
      para_etapa_id: string;
      evidencias: string[];
      motivo: string;
    }
  | {
      kind: 'mover_etapa';
      decisao: 'recomendar';
      code: 'RECOM';
      de_etapa_id: string | null;
      para_etapa_id: string;
      evidencias: string[];
      motivo: string;
      porque: MotivoDeRecomendacao;
    }
  | {
      kind: 'mover_etapa';
      decisao: 'bloquear';
      code: 'BLOQ';
      de_etapa_id: string | null;
      para_etapa_id: string;
      evidencias: string[];
      motivo: string;
      porque: MotivoDeBloqueio;
    }
  | {
      kind: 'registrar_pendencia';
      decisao: 'recomendar';
      code: 'RECOM';
      evidencias: string[];
      motivo: string;
      responsavel: string;
      porque: MotivoDeRecomendacao;
    };

/**
 * Converte a proposta do modelo em ações com código, contra a configuração e o
 * estado LIDO AGORA.
 *
 * Ordem das guardas, e por que é esta:
 *   1. estrutura (negócio existe, está aberto, contato não anonimizado);
 *   2. a etapa pedida existe NESTE funil;
 *   3. etapa terminal (ganho/perda) nunca por inferência — agendar e perder são
 *      decisões humanas;
 *   4. evidência: todo id citado precisa existir na conversa lida;
 *   5. conflito: pessoa mexeu na etapa depois do fato → não se sobrescreve;
 *   6. dúvida clínica/financeira/identidade, ou humano em atendimento → RECOM;
 *   7. modo e allowlist de transições → RECOM quando não autorizado;
 *   8. só então EXE (ainda PENDENTE de confirmação da ferramenta).
 */
export function avaliarProposta(
  proposta: PropostaDoSupervisor,
  estado: EstadoLido,
  vinculo: VinculoDeSupervisao,
): AcaoDecidida[] {
  const acoes: AcaoDecidida[] = [];
  const idsDeMensagem = new Set(estado.mensagens.map((m) => m.id));
  const evidenciaValida = (ids: readonly string[]): boolean =>
    ids.length > 0 && ids.every((id) => idsDeMensagem.has(id));

  const sensivel = proposta.tema_sensivel !== null || proposta.exige_revisao_humana;

  const mov = proposta.movimentacao;
  if (mov !== null) {
    const base = {
      kind: 'mover_etapa' as const,
      de_etapa_id: estado.lead?.stage_id ?? null,
      para_etapa_id: mov.para_etapa_id,
      evidencias: [...mov.evidencias],
      motivo: mov.motivo,
    };
    const bloquear = (porque: MotivoDeBloqueio): AcaoDecidida => ({ ...base, decisao: 'bloquear', code: 'BLOQ', porque });
    const recomendar = (porque: MotivoDeRecomendacao): AcaoDecidida => ({ ...base, decisao: 'recomendar', code: 'RECOM', porque });

    const etapa = estado.etapas.find((e) => e.id === mov.para_etapa_id && !e.is_archived) ?? null;

    if (estado.lead === null) acoes.push(bloquear('sem_negocio_no_funil'));
    else if (estado.contato.is_anonymized) acoes.push(bloquear('contato_anonimizado'));
    else if (estado.lead.status !== 'open') acoes.push(bloquear('negocio_encerrado'));
    else if (etapa === null) acoes.push(bloquear('etapa_inexistente_no_funil'));
    else if (etapa.id === estado.lead.stage_id) {
      // Já está lá: nada a fazer, e registrar "movi para onde já estava" seria
      // uma EXE sem efeito — exatamente o registro que mente.
    } else if (etapa.is_won || etapa.is_lost) acoes.push(bloquear('etapa_exige_confirmacao_humana'));
    else if (!evidenciaValida(mov.evidencias)) acoes.push(bloquear('evidencia_insuficiente'));
    else if (estado.mudancas_humanas_de_etapa_apos_evento.length > 0) acoes.push(bloquear('conflito_de_estado'));
    else if (sensivel || etapa.requires_human) acoes.push(recomendar('revisao_humana_necessaria'));
    else if (estado.conversa.em_atendimento_humano || estado.contato.force_human) {
      acoes.push(recomendar('atendimento_humano_em_curso'));
    } else if (vinculo.mode !== 'executar') acoes.push(recomendar('modo_recomendar'));
    else if (!transicaoAutorizada(vinculo.allowed_stage_moves, estado.lead.stage_id, etapa.id)) {
      acoes.push(recomendar('transicao_nao_autorizada'));
    } else {
      acoes.push({
        kind: 'mover_etapa',
        decisao: 'executar',
        code: 'EXE',
        de_etapa_id: estado.lead.stage_id,
        para_etapa_id: etapa.id,
        evidencias: [...mov.evidencias],
        motivo: mov.motivo,
      });
    }
  }

  // Pendências: sempre RECOM. Registrar a pendência na Central é o que torna a
  // recomendação visível; não é a IA decidindo por ninguém. Pendência sem
  // evidência válida continua sendo registrada — dúvida que não dá para apontar
  // numa mensagem ainda é dúvida que alguém precisa ver —, mas a lista de
  // evidências vai só com os ids que existem.
  for (const p of proposta.pendencias) {
    acoes.push({
      kind: 'registrar_pendencia',
      decisao: 'recomendar',
      code: 'RECOM',
      evidencias: p.evidencias.filter((id) => idsDeMensagem.has(id)),
      motivo: p.motivo,
      responsavel: p.responsavel,
      porque: 'pendencia_para_equipe',
    });
  }

  // Tema sensível sem pendência explícita: a dúvida precisa de dono mesmo que o
  // modelo tenha esquecido de nomeá-lo.
  if (proposta.tema_sensivel !== null && proposta.pendencias.length === 0) {
    acoes.push({
      kind: 'registrar_pendencia',
      decisao: 'recomendar',
      code: 'RECOM',
      evidencias: [],
      motivo: `Revisão humana necessária (tema ${proposta.tema_sensivel}).`,
      responsavel: 'equipe',
      porque: 'revisao_humana_necessaria',
    });
  }

  return acoes;
}

export function transicaoAutorizada(
  permitidas: readonly TransicaoAutorizada[],
  deEtapaId: string,
  paraEtapaId: string,
): boolean {
  return permitidas.some(
    (t) => t.to_stage_id === paraEtapaId && (t.from_stage_ids.length === 0 || t.from_stage_ids.includes(deEtapaId)),
  );
}

// ─── 4. o código da revisão ──────────────────────────────────────────────────

export type StatusFinalDaAcao = 'executada' | 'recomendada' | 'bloqueada' | 'falhou';

/**
 * O código que resume a revisão. EXE só se ALGUMA ação foi confirmada pela
 * ferramenta (status `executada`) — uma decisão `executar` que não chegou a
 * executar não conta. Revisão sem ação nenhuma não tem código: `nada_a_fazer`.
 */
export function codigoDaRevisao(statusDasAcoes: readonly StatusFinalDaAcao[]): CodigoDeResultado | null {
  if (statusDasAcoes.includes('executada')) return 'EXE';
  if (statusDasAcoes.includes('recomendada')) return 'RECOM';
  if (statusDasAcoes.includes('bloqueada') || statusDasAcoes.includes('falhou')) return 'BLOQ';
  return null;
}
