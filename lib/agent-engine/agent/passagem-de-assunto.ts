/**
 * A PASSAGEM DE ASSUNTO PELO PRÓPRIO AGENTE (`transfer_to_subject`).
 *
 * No roteador com `permanencia: 'agente'` o roteador escolhe quem COMEÇA a
 * conversa e só interrompe para os assuntos marcados. A troca no meio é de quem
 * está atendendo: ele vê a conversa inteira, o classificador vê um trecho. A
 * ferramenta grava o novo dono, o loop do modelo para, e `runAgentTurn`
 * reexecuta o turno UMA vez, no mesmo job, com o agente de destino. Mesmo job
 * é mesmo `send_ledger`: o retry não envia em dobro.
 *
 * Aqui mora o que dá para testar sem o turno: QUANDO a ferramenta existe, o
 * bloco de sistema, a forma do payload e a gravação. O `execute` e a
 * reexecução ficam em `inbound-turn.ts`.
 *
 * Limites conhecidos, que ficam:
 *
 * ponytail: a passagem é gravada ANTES de o destino provar que roda. Destino
 * quebrado (sem credencial, modelo fora) faz o job tentar com o destino até
 * morrer. Subir de degrau é desfazer a passagem quando a reexecução falha.
 *
 * ponytail: `gravarPassagem` não confere o lease do worker nem o dono que o
 * turno leu. Em produção quem segura a escrita fora de hora é
 * `guardServiceTools`, que o invariante não exercita. Subir de degrau é levar
 * o claim do job para dentro do statement.
 *
 * ponytail: um turno com passagem roda DOIS turnos completos (custo e
 * latência). Subir de degrau é a reexecução reaproveitar a leitura da origem.
 *
 * ponytail: efeitos de outras ferramentas de escrita que a origem chamou no
 * mesmo turno não entram no checkpoint do destino: o turno de origem não fecha.
 */
import type pg from 'pg';
import { z } from 'zod';

import type { ActivityType } from '@/lib/leads/activity-vocabulary';

import type { TurnAgentResolution } from './resolve-turn-agent';

export type AssuntoDoRoteador = NonNullable<TurnAgentResolution['assuntos']>[number];

/** Whitelist EXATA do payload da tool (mesmo padrão .strict() das vizinhas). */
export const transferToSubjectInputSchema = z.strictObject({
  subject: z.string().min(1).max(120),
  reason: z.string().min(1).max(300),
});

/** A chave que a passagem deixa no payload do job. Ver `gravarPassagem`. */
export const MARCA_DA_PASSAGEM_NO_JOB = 'passagem_feita';

/**
 * A segunda chave, só quando a ORIGEM teve envio aceito e passou no mesmo
 * turno. É ela, e só ela, que faz o retry do job encerrar sem modelo: a
 * mensagem já tem a resposta da origem, e rodar de novo entregaria o turno ao
 * novo dono, com outro texto.
 *
 * Separada de `passagem_feita` de propósito. Quando quem enviou foi o DESTINO
 * e a resposta falhou no meio, o retry TEM de rodar: o `send_ledger` devolve
 * `already_sent` para as bolhas aceitas e as que faltam saem, como em qualquer
 * job. Com uma chave só os dois casos eram o mesmo, e a resposta do destino
 * ficava pela metade com o job `done`.
 */
export const MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB = 'passagem_com_envio_da_origem';

/** O tipo da linha na linha do tempo do negócio (`crm_lead_activities.type`). */
export const ATIVIDADE_DA_PASSAGEM = 'subject_transferred' satisfies ActivityType;

/**
 * Os assuntos para os quais ESTE turno pode passar a conversa. Lista vazia é
 * "a ferramenta e o bloco não existem", e é a resposta em todo turno que não
 * satisfaça TODAS as condições: o turno do roteador de sempre fica byte a byte
 * o que era.
 *
 * Modo assistido não aparece aqui porque nunca chega: o turno do assistido vira
 * rascunho antes de montar ferramenta.
 */
export function outrosAssuntosDoTurno(t: {
  previa: boolean;
  jobKind: string | null;
  /** O turno já É a reexecução de uma passagem, ou o retry de um job que já passou. */
  jaPassou: boolean;
  routed: Pick<TurnAgentResolution, 'routerId' | 'assuntos' | 'permanencia'>;
  agentId: string | null;
}): AssuntoDoRoteador[] {
  const assuntos = t.routed.assuntos ?? [];
  if (
    t.previa ||
    t.jobKind !== 'inbound_turn' ||
    t.jaPassou ||
    t.routed.routerId === null ||
    t.routed.permanencia !== 'agente' ||
    t.agentId === null ||
    // Fallback do roteador ou agente da sessão: quem atende não é um assunto.
    !assuntos.some((a) => a.agentId === t.agentId)
  ) {
    return [];
  }
  // Por AGENTE, não por nome: dois assuntos do mesmo agente não são passagem.
  return assuntos.filter((a) => a.agentId !== t.agentId);
}

const MAXIMO_DA_DESCRICAO = 240;

/** Bloco de sistema RESIDENTE. Só entra junto com a ferramenta que ele nomeia. */
export function blocoDaPassagem(
  outros: ReadonlyArray<Pick<AssuntoDoRoteador, 'intentName' | 'description'>>,
): string {
  return [
    '## Outros assuntos deste atendimento',
    'Você atende um assunto. Se o que a pessoa quer agora é de outro assunto da lista abaixo, chame `transfer_to_subject` ANTES de responder e não envie nenhuma mensagem neste turno: outro atendente, com o roteiro certo, responde a mesma mensagem. Não conduza você o atendimento de outro assunto. Na dúvida entre ficar e passar, pergunte à pessoa.',
    // A descrição é texto livre da tela: quebra de linha desmontaria a lista.
    ...outros.map(
      (o) => `- ${o.intentName}: ${o.description.replace(/\s+/g, ' ').trim().slice(0, MAXIMO_DA_DESCRICAO)}`,
    ),
  ].join('\n');
}

/**
 * Grava a passagem: novo dono da conversa, a linha de decisão e a marca no job.
 * UM statement, de propósito: dono trocado sem a marca deixaria o retry do job
 * oferecer a ferramenta de novo, e a conversa poderia voltar.
 *
 * A marca no payload do job (`passagem_feita`) é o que faz "no máximo uma
 * passagem por mensagem recebida" valer também no retry, sem consulta: o job
 * reivindicado de novo já traz o payload. `origemJaEnviou` acrescenta a
 * segunda marca (`MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB`) no mesmo statement.
 *
 * ponytail: `confidence` nulo com `outcome = 'reclassified'` é o que identifica
 * a passagem pelo agente (o roteador sempre grava um número). Um outcome
 * próprio pede migration para alargar o CHECK de `ai_router_decisions`.
 */
export async function gravarPassagem(
  db: pg.Pool,
  a: {
    tenantId: string;
    conversationId: string;
    routerId: string;
    jobId: string;
    destino: { agentId: string; intentName: string };
    /** A origem já teve envio aceito NESTE turno: grava também `MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB`. */
    origemJaEnviou?: boolean;
  },
): Promise<void> {
  const { rowCount } = await db.query(
    `with dono as (
       update conversations
          set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
        where organization_id = $1 and id = $2
        returning id
     ),
     marca as (
       update job_queue
          set payload = payload || jsonb_build_object($7::text, true)
                || case when $8 then jsonb_build_object($9::text, true) else '{}'::jsonb end
        where organization_id = $1 and id = $6 and exists (select 1 from dono)
     )
     insert into ai_router_decisions
       (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id)
     select $1, $5, dono.id, $4, null, $3, 'reclassified', $6 from dono`,
    [
      a.tenantId,
      a.conversationId,
      a.destino.agentId,
      a.destino.intentName,
      a.routerId,
      a.jobId,
      MARCA_DA_PASSAGEM_NO_JOB,
      a.origemJaEnviou === true,
      MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB,
    ],
  );
  if (rowCount !== 1) throw new Error('passagem de assunto: conversa não encontrada nesta organização');
}

/**
 * Grava `MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB` fora de `gravarPassagem`: é o caso em
 * que o envio da origem foi aceito DEPOIS de a passagem ser gravada (as duas
 * ferramentas no mesmo passo, que o SDK roda em paralelo).
 */
export async function marcarEnvioDaOrigem(db: pg.Pool, a: { tenantId: string; jobId: string }): Promise<void> {
  await db.query(
    `update job_queue set payload = payload || jsonb_build_object($3::text, true)
      where organization_id = $1 and id = $2`,
    [a.tenantId, a.jobId, MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB],
  );
}

/**
 * O job já tem envio de uma TENTATIVA ANTERIOR? `seq` é o contador de envios
 * desta tentativa: linha do ledger acima dele só pode ter sido escrita por uma
 * tentativa que foi mais longe. Passar a conversa aí reexecutaria o destino
 * sobre chaves `(job, seq)` já usadas, e a primeira bolha dele voltaria como
 * `already_sent`, engolida. As que falharam não contam: o ledger roda a chave.
 */
export async function jobTemEnvioDeTentativaAnterior(
  db: pg.Pool,
  a: { tenantId: string; jobId: string; seq: number },
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from send_ledger
      where organization_id = $1 and job_id = $2 and seq > $3 and status <> 'failed'
      limit 1`,
    [a.tenantId, a.jobId, a.seq],
  );
  return rows.length > 0;
}

const MAXIMO_DO_MOTIVO = 300;

/**
 * A linha da passagem na linha do tempo do negócio: sem ela a recepção via o
 * agente da conversa mudar e mais nada.
 *
 * O motivo é texto do MODELO sobre a conversa. Entra aqui, em uma linha e
 * cortado, porque a atividade é dado do tenant que a equipe lê. Não vai para
 * `ai_router_decisions` (tabela sem texto do lead) nem para log.
 */
export function atividadeDaPassagem(p: {
  conversationId: string;
  de: { agentId: string; agentName: string; intentName: string | null };
  para: { agentId: string; agentName: string; intentName: string };
  motivo: string;
}): { type: typeof ATIVIDADE_DA_PASSAGEM; reason: string; payload: Record<string, unknown> } {
  const motivo = p.motivo.replace(/\s+/g, ' ').trim().slice(0, MAXIMO_DO_MOTIVO);
  const de = p.de.intentName !== null ? `Do assunto ${p.de.intentName} (${p.de.agentName})` : `De ${p.de.agentName}`;
  return {
    type: ATIVIDADE_DA_PASSAGEM,
    reason:
      `${de} para o assunto ${p.para.intentName} (${p.para.agentName}).` + (motivo !== '' ? ` Motivo: ${motivo}` : ''),
    payload: {
      conversation_id: p.conversationId,
      de_assunto: p.de.intentName,
      de_agent_id: p.de.agentId,
      de_agente: p.de.agentName,
      para_assunto: p.para.intentName,
      para_agent_id: p.para.agentId,
      para_agente: p.para.agentName,
    },
  };
}
