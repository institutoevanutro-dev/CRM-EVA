/**
 * Supervisão de agente — o que o MODELO pode dizer, e só isso.
 *
 * O supervisor não recebe ferramenta nenhuma. Ele lê um retrato da conversa e
 * devolve UMA proposta em JSON, validada por zod. Não há `send_message`, não há
 * MCP, não há chamada que mova card: quem move é o executor, depois de a
 * política (`politica.ts`) autorizar. Um modelo que "decida" confirmar
 * pagamento não tem por onde fazê-lo.
 *
 * As políticas da clínica vivem no prompt PUBLICADO do agente supervisor (tela
 * do agente). Este arquivo só enquadra: formato, limites e o que nunca fazer.
 */
import { z } from 'zod';

import type { EstadoLido, VinculoDeSupervisao } from './politica';
import type { EventoDeRevisao } from './contrato';

export const TEMAS_SENSIVEIS = ['clinico', 'financeiro', 'identidade'] as const;

export const CLASSIFICACOES = [
  'paciente',
  'contato_administrativo',
  'fornecedor',
  'indefinido',
] as const;

const idCurto = z.string().uuid();

export const propostaDoSupervisorSchema = z
  .object({
    classificacao: z.enum(CLASSIFICACOES),
    /** O que a revisão concluiu sobre a execução revisada, em uma ou duas frases. */
    avaliacao: z.string().min(1).max(600),
    movimentacao: z
      .object({
        para_etapa_id: idCurto,
        motivo: z.string().min(1).max(400),
        evidencias: z.array(idCurto).max(10),
      })
      .strict()
      .nullable(),
    pendencias: z
      .array(
        z
          .object({
            motivo: z.string().min(1).max(400),
            responsavel: z.enum(['equipe', 'agenda', 'financeiro', 'clinico', 'administracao']),
            evidencias: z.array(idCurto).max(10),
          })
          .strict(),
      )
      .max(5),
    exige_revisao_humana: z.boolean(),
    tema_sensivel: z.enum(TEMAS_SENSIVEIS).nullable(),
  })
  .strict();
export type PropostaDoSupervisor = z.infer<typeof propostaDoSupervisorSchema>;

/**
 * O enquadramento fixo. Complementa — nunca substitui — as políticas escritas no
 * prompt publicado do supervisor. Versionado por `VERSAO_DO_ENQUADRAMENTO`.
 */
export const SYSTEM_DO_SUPERVISOR =
  'Você é o SUPERVISOR administrativo de um atendimento. Você revisa, depois do fato, o que outro ' +
  'agente ou uma pessoa da equipe acabou de concluir numa conversa, e compara com as políticas ' +
  'da organização descritas abaixo.\n\n' +
  'VOCÊ NÃO FALA COM O PACIENTE OU CLIENTE. Você não tem canal de envio e não deve redigir mensagem ' +
  'para ele. Correções de conversa ficam para a equipe.\n\n' +
  'VOCÊ NÃO EXECUTA NADA. Você devolve UMA proposta em JSON. O sistema decide o que é permitido.\n\n' +
  'NUNCA proponha, nem descreva como feito: liberar horário, confirmar pagamento ou recebimento, ' +
  'criar ou confirmar agendamento, marcar falta, classificar perda do negócio. Se a conversa sugerir ' +
  'uma dessas coisas, registre uma pendência para a equipe.\n\n' +
  'Dúvida clínica, financeira ou de identidade: marque `tema_sensivel`, `exige_revisao_humana: true` ' +
  'e registre pendência. Não resolva por inferência.\n\n' +
  'Evidência: toda movimentação e toda pendência citam os IDS das mensagens que a sustentam, ' +
  'copiados da lista. Sem evidência na conversa, não proponha movimentação.\n\n' +
  'Só proponha movimentação para uma etapa da lista de etapas, pelo id. Não invente etapa nem etiqueta.\n\n' +
  'Escreva motivos e avaliação em termos ADMINISTRATIVOS. Não copie sintomas, diagnósticos, valores ' +
  'de exames ou dados de comprovante: o registro é lido pela equipe inteira.\n\n' +
  'Responda SOMENTE com o JSON, sem texto antes ou depois, neste formato:\n' +
  '{"classificacao":"paciente|contato_administrativo|fornecedor|indefinido",' +
  '"avaliacao":"...",' +
  '"movimentacao":null | {"para_etapa_id":"<id>","motivo":"...","evidencias":["<id da mensagem>"]},' +
  '"pendencias":[{"motivo":"...","responsavel":"equipe|agenda|financeiro|clinico|administracao","evidencias":["<id>"]}],' +
  '"exige_revisao_humana":true|false,' +
  '"tema_sensivel":null|"clinico"|"financeiro"|"identidade"}';

const LIMITE_DE_CARACTERES_POR_MENSAGEM = 1200;

/** O briefing: políticas do supervisor + o retrato da conversa, em texto. */
export function montarBriefingDoSupervisor(input: {
  politicasPublicadas: string;
  evento: EventoDeRevisao;
  estado: EstadoLido;
  vinculo: VinculoDeSupervisao;
  agoraBlock: string;
}): string {
  const { estado, evento } = input;
  const etapaAtual = estado.etapas.find((e) => e.id === estado.lead?.stage_id)?.name ?? '(sem negócio neste funil)';
  const linhas: string[] = [];
  linhas.push(input.agoraBlock, '');
  linhas.push('## Políticas da organização (publicadas no agente supervisor)');
  linhas.push(input.politicasPublicadas.trim() === '' ? '(nenhuma política escrita)' : input.politicasPublicadas.trim());
  linhas.push('', '## O fato revisado');
  linhas.push(
    evento.actor_type === 'ai_agent'
      ? `Uma execução do agente supervisionado terminou em ${evento.occurred_at}.`
      : `Uma pessoa da equipe concluiu uma ação (${evento.origin === 'human_stage_changed' ? 'moveu o negócio de etapa' : 'enviou mensagem'}) em ${evento.occurred_at}.`,
  );
  linhas.push('', '## Estado atual');
  linhas.push(`Etapa atual: ${etapaAtual}`);
  linhas.push(`Negócio: ${estado.lead === null ? 'não existe neste funil' : estado.lead.status === 'open' ? 'aberto' : 'encerrado'}`);
  linhas.push(`Pediu para não receber mensagens: ${estado.contato.is_blocked ? 'sim' : 'não'}`);
  linhas.push(`Atendimento humano em curso: ${estado.conversa.em_atendimento_humano || estado.contato.force_human ? 'sim' : 'não'}`);
  linhas.push(`Agendamentos futuros: ${estado.agendamentos_futuros.length === 0 ? 'nenhum' : estado.agendamentos_futuros.map((a) => `${a.status} em ${a.starts_at}`).join('; ')}`);
  linhas.push(`Sequências de acompanhamento vivas: ${estado.followups_vivos.length}`);
  linhas.push('', '## Etapas deste funil (use o id)');
  for (const e of estado.etapas.filter((x) => !x.is_archived)) {
    const marcas = [e.is_won ? 'ganho' : null, e.is_lost ? 'perda' : null, e.requires_human ? 'exige humano' : null]
      .filter(Boolean)
      .join(', ');
    linhas.push(`- ${e.id} — ${e.name}${marcas ? ` (${marcas})` : ''}`);
  }
  linhas.push('', '## Conversa (mais antiga primeiro; use o id como evidência)');
  for (const m of estado.mensagens) {
    const quem = m.direction === 'inbound' ? 'CONTATO' : m.sent_via === 'ai' ? 'AGENTE' : m.sent_by_user_id ? 'EQUIPE' : 'SISTEMA';
    const corpo = (m.body ?? `[${m.type}]`).slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM);
    linhas.push(`[${m.id}] ${m.created_at} ${quem}: ${corpo}`);
  }
  linhas.push('', 'Devolva a proposta em JSON.');
  return linhas.join('\n');
}

export type LeituraDaProposta =
  | { ok: true; proposta: PropostaDoSupervisor }
  | { ok: false; porque: 'sem_json' | 'json_invalido' | 'formato_invalido' };

/**
 * Extrai e valida o JSON. Texto fora do formato NUNCA é tratado como "nada a
 * fazer": vira BLOQ `resposta_do_supervisor_invalida`, visível. Um parser
 * otimista transformaria resposta quebrada em revisão aprovada.
 */
export function lerPropostaDoSupervisor(texto: string): LeituraDaProposta {
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio < 0 || fim <= inicio) return { ok: false, porque: 'sem_json' };
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto.slice(inicio, fim + 1));
  } catch {
    return { ok: false, porque: 'json_invalido' };
  }
  const parsed = propostaDoSupervisorSchema.safeParse(bruto);
  return parsed.success ? { ok: true, proposta: parsed.data } : { ok: false, porque: 'formato_invalido' };
}
