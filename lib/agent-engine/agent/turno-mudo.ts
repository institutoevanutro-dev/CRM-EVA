import type { ModelMessage } from 'ai';

/**
 * TURNO MUDO — o turno de resposta que terminou sem mensagem ao cliente.
 *
 * A resposta ao cliente só sai por `send_message`/`send_template`; o texto que o
 * modelo escreve fora delas não chega a ninguém. Medido numa instalação real
 * (06/10/2026): o cliente mandou os dados de entrega, o agente gravou o pedido,
 * perguntou o sobrenome em TEXTO SOLTO e encerrou — `messages_sent: 0`, sem
 * veto, sem descarte, e o cliente ficou sem resposta logo depois de passar os
 * dados. Nada no motor percebia.
 *
 * O silêncio às vezes é decisão, e aí não há o que corrigir:
 * - algo SAIU (`enviadas > 0`) — a conversa foi respondida;
 * - o turno foi DESCARTADO (`turnoDescartado`): a resposta ficou obsoleta (o
 *   cliente escreveu de novo; o turno da mensagem nova responde a tudo), a guarda
 *   de repetição calou a fala ou já mandou a frase fixa/o caso, ou uma pessoa
 *   assumiu a conversa;
 * - a conversa foi passada à equipe (o aviso da escalação é do sistema);
 * - o cap de envio do número barrou (o turno é reagendado mais abaixo);
 * - a cadeia vetou com um código que manda PARAR (opt-out, contato interno,
 *   conversa com a equipe, LGPD, janela de envio fechada): reescrever não muda o
 *   veredito.
 *
 * ⚠️ Tentativa de envio que levou VETO não é razão legítima — e já foi. A
 * regra antiga exigia `tentativasDeEnvio === 0` com o argumento "o veto já
 * ensinou". Medido no original (teste 10 do aceite, 2026-10-25, job 217c6925):
 * o modelo chamou `send_message` 2×, o `agenda_stall` vetou as duas (o erro de
 * ensino voltou DENTRO do loop) e ele encerrou o turno com texto solto — a
 * correção era o único caminho de recuperação e a regra a suprimiu. Resultado:
 * cliente sem resposta e agenda intacta. Veto não entregou nada; quem mede
 * silêncio defeito é `enviadas`, não tentativas. Por isso cada descarte que
 * antes chegava aqui "de carona" na tentativa (a resposta obsoleta e o pulo da
 * guarda de repetição acontecem dentro do `send_message`) agora chega dito, por
 * `turnoDescartado` (porte do #3673).
 *
 * Fora disso, o motor pede UMA correção, com a mesma conversa e as mesmas
 * ferramentas — o mesmo desenho de `fecharOTurno` para o JSON de fechamento. O
 * modelo ainda pode decidir não responder; o que muda é que ele decide sabendo
 * que nada saiu.
 */
export const CORRECAO_DO_TURNO_MUDO =
  'Este turno terminou SEM nenhuma mensagem ao cliente: texto escrito fora de send_message não chega a ele. ' +
  'Se você tem algo a dizer ao cliente (resposta, pergunta, resumo do pedido), chame send_message agora, ' +
  'no idioma da conversa, com o texto final. Se decidiu de propósito não responder, encerre sem chamar nada.';

// AGENDA — a receita do caso que a correção JÁ recebeu e errou (medido no original,
// teste 10 do aceite, 2026-10-26, job 5ca40cb3): o diálogo trazia o veto de agenda e a
// correção resolveu o "falta mexer na agenda" como NOVO agendamento, criando uma SEGUNDA
// consulta com a original intacta. Este trecho diz o caminho (localizar SEM `dia` — o dia
// chutado devolve lista vazia — e MOVER o mesmo compromisso) e a ordem (mudar a agenda
// ANTES de responder). Só vale quando o erro de ensino no diálogo é de agenda; noutras
// conversas a condição não casa e o modelo segue o texto de cima.
const RECEITA_DE_REMARCAR =
  'Se o erro de ensino neste diálogo é de AGENDA (você afirmou um horário confirmado sem a marcação ter sido gravada) ' +
  'e o cliente está mudando um compromisso já marcado: localize-o com crm_list_appointments usando SÓ ' +
  'o contact_id — sem `dia`, porque o dia que você chutar devolve lista vazia e você não acha o ' +
  'compromisso — e MOVA o mesmo compromisso com crm_reschedule_appointment. Nunca marque um ' +
  'compromisso novo para remarcar: isso cria um SEGUNDO compromisso e deixa o antigo no lugar. ' +
  'Só depois de a agenda ter mudado de fato (a resposta trouxe "remarcado: true"), mande a ' +
  'confirmação por send_message com o resultado real; se a agenda não mudou, avise por ' +
  'send_message em vez de confirmar.';

/**
 * O pedido de correção para ESTE agente: o texto base e, só para quem lista E remarca
 * compromissos, a receita de remarcar.
 *
 * A receita nomeia `crm_list_appointments` e `crm_reschedule_appointment`; nomear
 * ferramenta que o agente não tem faz o modelo tentar chamá-la (a doutrina de
 * `ferramentasDeAgendaDoAgente`, `inbound-turn.ts`), e desde o #3673 a correção roda
 * também depois de todo veto de ensino. Pelo mesmo motivo ela não nomeia ferramenta de
 * marcar, como o original nomeava.
 */
export function correcaoDoTurnoMudo(toolIds: readonly string[]): string {
  return toolIds.includes('crm_list_appointments') && toolIds.includes('crm_reschedule_appointment')
    ? `${CORRECAO_DO_TURNO_MUDO} ${RECEITA_DE_REMARCAR}`
    : CORRECAO_DO_TURNO_MUDO;
}

/**
 * Teto de passos da correção. Folgado, não arbitrário: com 3 a correção do teste 10
 * (2026-10-26, job 5ca40cb3) gastou os três em ferramentas de agenda e parou antes do
 * send_message (`messages_sent: 0`). A receita de remarcar são 4 saídas de modelo
 * (localizar → slot → mover → enviar); 6 deixa folga sem deixar de ser limite — a
 * correção continua UMA chamada.
 */
export const PASSOS_DA_CORRECAO = 6;

export function turnoMudoPedeCorrecao(t: {
  /**
   * `send_message`/`send_template` chamados (vetados inclusive). Informativo —
   * NÃO gateia: tentativa vetada não entregou nada ao cliente (ver a nota
   * "VETO não é razão legítima" no cabeçalho deste arquivo).
   */
  tentativasDeEnvio: number;
  /**
   * A cadeia vetou um envio com um código que manda PARAR (`VETOS_IRREVOGAVEIS`).
   * Diferente do veto de ensino, aqui a correção pediria ao modelo que tentasse
   * de novo o que o veto proíbe: o silêncio é a decisão.
   */
  vetoIrrevogavel: boolean;
  enviadas: number;
  turnoDescartado: boolean;
  passouParaAEquipe: boolean;
  capDeEnvio: boolean;
}): boolean {
  return (
    t.enviadas === 0 &&
    !t.vetoIrrevogavel &&
    !t.turnoDescartado &&
    !t.passouParaAEquipe &&
    !t.capDeEnvio
  );
}

/**
 * A FALHA do turno mudo: nada saiu ao cliente E o modelo foi cortado no teto de
 * tokens de saída (`finishReason === 'length'`), na chamada principal ou na
 * correção (porte do upstream #2938).
 *
 * A resposta cortada nunca sai: o AI SDK não executa ferramenta de um passo que
 * terminou em `length` (`isToolExecutionAllowedFinishReason`, preso em
 * `tests/unit/saida-cortada-nao-vai-ao-cliente.test.ts`), e texto fora de
 * `send_message` não chega a ninguém. O que faltava era alguém saber: o turno
 * acabava mudo com um log de `info`.
 *
 * As razões legítimas de silêncio são as MESMAS de `turnoMudoPedeCorrecao`, lidas
 * DEPOIS da correção: se nela algo saiu, a conversa passou à equipe, o número bateu
 * no teto, o turno foi descartado ou a cadeia vetou com um código que manda parar,
 * aquilo é a razão e não há aviso. Silêncio sem corte é decisão — a correção
 * autoriza o modelo a não responder — e também não avisa.
 *
 * Qual corte avisa: o da CORREÇÃO, sempre — ela era a última chance e nada saiu
 * (desde o #3673 ela roda também depois de um veto, e o original não avisava esse
 * caso); o da resposta principal, só sem tentativa de envio. Resposta principal
 * cortada depois de um veto não avisa sozinha: o ensino já tinha voltado ao modelo,
 * a correção rodou inteira, e o silêncio dela foi decisão.
 */
export function turnoMudoPorCorte(
  t: Parameters<typeof turnoMudoPedeCorrecao>[0] & { saidaCortada: boolean; correcaoCortada: boolean },
): boolean {
  return (t.correcaoCortada || (t.saidaCortada && t.tentativasDeEnvio === 0)) && turnoMudoPedeCorrecao(t);
}

/**
 * Por que o turno mudo vira aviso na Central, ou `null` quando o silêncio é decisão
 * (porte do #4038 do original). Além do corte (`turnoMudoPorCorte`), dois sinais de
 * FALHA da correção, lidos depois dela:
 * - `correcao_barrada`: ela CHAMOU send_message/send_template e nada saiu — o modelo
 *   quis responder e a cadeia barrou de novo com um veto de ensino;
 * - `correcao_sem_resposta`: ela gastou o teto de passos (`PASSOS_DA_CORRECAO`) só em
 *   consultas, sem chegar a responder.
 * - `correcao_calada_apos_veto`: a resposta principal TENTOU enviar, foi barrada por
 *   veto de ensino, e a correção encerrou sem chamar nada. O modelo queria responder e
 *   desistiu depois do veto: não é silêncio escolhido (ex.: o fail-safe de caso humano
 *   recusou abrir caso e a promessa nunca saiu, #3725).
 * A correção que encerra SEM CHAMAR NADA, num turno em que nada foi tentado, segue sem
 * aviso (silêncio escolhido), e o veto irrevogável continua isentando:
 * `turnoMudoPedeCorrecao` já o lê.
 */
export type FalhaDoTurnoMudo =
  | 'corte'
  | 'correcao_barrada'
  | 'correcao_sem_resposta'
  | 'correcao_calada_apos_veto';

export function falhaDoTurnoMudo(
  t: Parameters<typeof turnoMudoPorCorte>[0] & { correcaoTentouEnviar: boolean; tetoNaCorrecao: boolean },
): FalhaDoTurnoMudo | null {
  if (turnoMudoPorCorte(t)) return 'corte';
  if (!turnoMudoPedeCorrecao(t)) return null;
  if (t.correcaoTentouEnviar) return 'correcao_barrada';
  if (t.tetoNaCorrecao) return 'correcao_sem_resposta';
  if (t.tentativasDeEnvio > 0) return 'correcao_calada_apos_veto';
  return null;
}

/**
 * A fita da resposta cortada, sem as chamadas de ferramenta que ficaram sem
 * resultado. O passo cortado no teto de tokens não executa ferramenta, mas a
 * chamada continua na fita; reenviá-la na correção faz o AI SDK recusar o pedido
 * (`AI_MissingToolResultsError`) e o turno cair inteiro na fila de novo, com o
 * cliente ainda sem resposta. O resto (texto e as ferramentas que rodaram nos
 * passos anteriores) fica: a correção não repete a consulta que já tem.
 */
export function semChamadasSemResultado(messages: ModelMessage[]): ModelMessage[] {
  const respondidas = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    for (const part of m.content) if (part.type === 'tool-result') respondidas.add(part.toolCallId);
  }
  return messages.flatMap((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return [m];
    const content = m.content.filter((part) => part.type !== 'tool-call' || respondidas.has(part.toolCallId));
    return content.length > 0 ? [{ ...m, content }] : [];
  });
}
