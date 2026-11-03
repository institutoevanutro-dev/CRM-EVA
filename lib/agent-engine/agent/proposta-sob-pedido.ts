/**
 * PROPOSTA SOB PEDIDO — "Sugerir resposta" propõe um texto quando o agente
 * automático ficaria em silêncio (porte do original: PR #3557, issue #3281).
 *
 * O caso medido lá: a clínica responde primeiro com o aviso automático do
 * WhatsApp Business, o agente cala (certo) e, mais tarde, uma PESSOA escreve
 * "Bom dia!" e "Como posso ajudar?". A regra do prompt lê as duas como robô, o
 * turno automático cala — e o clique em "Sugerir resposta" devolvia o mesmo
 * vazio, justamente quando quem atende sabia mais que a regra.
 *
 * Só o silêncio inicial sem oferta, veto ou falha ganha a instrução, e ela ocupa
 * a vaga da correção do turno mudo (`turno-mudo.ts`): nunca há terceira chamada.
 *
 * Neste fork a régua só vale no CLIQUE (`TurnPreview.pedidoHumano`, ligado só
 * pela rota `draft-reply`): o rascunho que o worker escreve sozinho para agente
 * em modo assistido não diz que uma pessoa pediu, nem paga uma chamada a mais em
 * toda mensagem em que calar é o certo. E não há a correção de texto solto da
 * prévia (PR #3093 do original), que este fork ainda não tem: texto solto na
 * prévia continua terminando sem candidato.
 */
import type { FinishReason } from 'ai';

export const INSTRUCAO_DO_PEDIDO_HUMANO =
  'Uma pessoa da equipe clicou em "Sugerir resposta" e pediu um texto para esta conversa. ' +
  'O turno automático poderia ficar em silêncio, mas agora há um pedido humano de uma proposta. ' +
  'Chame send_message uma vez, no idioma da conversa, com somente a mensagem destinada ao cliente. ' +
  'As regras de conteúdo e a cadeia de envio continuam valendo: nada chega ao cliente sem a ' +
  'aprovação de quem pediu.';

/** Sinais do primeiro turno, antes de ocupar a única recuperação disponível. */
export interface SinaisDoPedidoHumano {
  readonly candidatos: number;
  readonly propostas: number;
  readonly impedimentos: readonly string[];
  readonly tentativasDeEnvio: number;
  readonly textoEscrito: string;
  readonly inboundsSemResposta: number;
  readonly finishReason: FinishReason | undefined;
  readonly saidaTruncada: boolean;
  readonly tetoDePassosAtingido: boolean;
}

/** Só stop confirma silêncio normal; filtro/erro não autoriza pedir texto de novo. */
export function previaContinuaAtePropor(p: SinaisDoPedidoHumano): boolean {
  return (
    p.finishReason === 'stop' &&
    p.candidatos === 0 &&
    p.propostas === 0 &&
    p.impedimentos.length === 0 &&
    p.tentativasDeEnvio === 0 &&
    p.textoEscrito.trim() === '' &&
    p.inboundsSemResposta > 0 &&
    !p.saidaTruncada &&
    !p.tetoDePassosAtingido
  );
}

/**
 * O turno parou no teto de passos ainda chamando ferramenta: falha de geração,
 * não silêncio decidido. Vem de `desfecho-da-previa.ts` do original (#3093), que
 * este fork não tem; é o único pedaço dele de que o #3557 precisa.
 */
export function tetoDePassosAtingido(p: {
  passosUsados: number;
  maxSteps: number;
  finishReason: FinishReason | undefined;
}): boolean {
  return p.maxSteps > 0 && p.passosUsados >= p.maxSteps && p.finishReason === 'tool-calls';
}
