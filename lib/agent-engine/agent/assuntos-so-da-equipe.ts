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
 * As descrições dizem com exemplos o que NÃO é (cliente perguntando convênio,
 * parceria de desconto, nosso horário, valores ou opções): o pior erro aqui é
 * calar um cliente real.
 */
export const ASSUNTOS_SO_DA_EQUIPE: readonly RouterMember[] = [
  {
    agentId: '',
    intentName: 'negocio_com_a_empresa',
    intentDescription:
      'fornecedor, vendedor ou representante de OUTRA empresa oferecendo produto ou serviço À EMPRESA, proposta comercial ou de parceria feita À EMPRESA, divulgação, cobrança de outra empresa. ' +
      'NÃO inclui cliente ou paciente: quem quer ser atendido, comprar ou agendar; quem pergunta se a empresa aceita o convênio ou plano dele; ' +
      'quem pergunta por parceria de desconto, preço, valores ou formas de pagamento. Exemplos que NÃO são: "vocês têm parceria com o meu convênio?", ' +
      '"tem desconto pela parceria da minha empresa?", "aceitam meu plano?"',
    examples: [],
  },
  {
    agentId: '',
    intentName: 'mensagem_automatica',
    intentDescription:
      'mensagem que INFORMA, em nome de OUTRA empresa ou robô, o horário dela, um menu de opções dela ou que a mensagem foi recebida ' +
      '("recebemos sua mensagem", "esta é uma mensagem automática", "digite 1 para…"). ' +
      'NÃO inclui perguntas do cliente sobre o NOSSO horário, valores ou opções, nem quem cita um menu ou site',
    examples: [],
  },
];

const NOMES_SO_DA_EQUIPE = new Set(ASSUNTOS_SO_DA_EQUIPE.map((m) => m.intentName));

/** O nome é de uma intenção fixa do produto (não de um membro do roteador)? */
export function ehAssuntoFixoSoDaEquipe(intentName: string | null): boolean {
  return intentName !== null && NOMES_SO_DA_EQUIPE.has(intentName);
}
