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
 */
import type pg from 'pg';
import { z } from 'zod';

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
 * reivindicado de novo já traz o payload.
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
    ],
  );
  if (rowCount !== 1) throw new Error('passagem de assunto: conversa não encontrada nesta organização');
}
