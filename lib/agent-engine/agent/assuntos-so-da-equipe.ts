/**
 * Intenções FIXAS do produto, oferecidas ao classificador do roteador só
 * quando ele liga `config.so_equipe` (`intent-classifier.ts`). Não têm agente
 * (`agentId` vazio): quem decide o que fazer com elas é `resolve-turn-agent.ts`
 * (regra 9: passa à equipe, sem resposta da IA).
 *
 * Módulo próprio, sem dependência: o resolvedor lê os nomes daqui, e os testes
 * que substituem o classificador por um dublê não levam a lista junto.
 */
import type { RouterMember } from './router-config';

/**
 * A descrição exclui de propósito o que um cliente pergunta sobre convênio,
 * plano, preço ou pagamento: o pior erro aqui é calar um cliente real.
 */
export const ASSUNTOS_SO_DA_EQUIPE: readonly RouterMember[] = [
  {
    agentId: '',
    intentName: 'negocio_com_a_empresa',
    intentDescription:
      'fornecedor, vendedor ou representante oferecendo produto ou serviço À EMPRESA, proposta comercial ou de parceria, divulgação, cobrança de outra empresa. NÃO inclui quem quer ser atendido ou comprar, nem pergunta sobre convênio, plano, preço ou pagamento',
    examples: [],
  },
  {
    agentId: '',
    intentName: 'mensagem_automatica',
    intentDescription:
      'resposta automática de outra empresa ou robô: "recebemos sua mensagem", horário de atendimento, menu de opções numeradas, "esta é uma mensagem automática"',
    examples: [],
  },
];

const NOMES_SO_DA_EQUIPE = new Set(ASSUNTOS_SO_DA_EQUIPE.map((m) => m.intentName));

/** O nome é de uma intenção fixa do produto (não de um membro do roteador)? */
export function ehAssuntoFixoSoDaEquipe(intentName: string | null): boolean {
  return intentName !== null && NOMES_SO_DA_EQUIPE.has(intentName);
}
