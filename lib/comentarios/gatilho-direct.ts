/**
 * QUANDO um comentário barrado pela trava vira uma conversa no Direct, e com
 * que palavras.
 *
 * A trava (`lib/comentarios/seguranca.ts`) recusa publicar resposta pública
 * sozinha e rotula o porquê. Dois desses rótulos são intenção de compra —
 * alguém perguntando preço ou querendo marcar —, e deixar essa pessoa só na
 * fila humana perde a venda enquanto ela ainda está olhando o vídeo. Os
 * outros NÃO abrem conversa automática: medicação e sintoma são assunto
 * clínico, especialidade expõe o dono no CFM (ele é médico, sem RQE), e
 * reclamação é conversa que merece um humano desde a primeira palavra.
 *
 * ⚠️ A privada é o único canal por onde preço pode ser tratado. Resposta
 * PÚBLICA sobre preço continua proibida — quem veta isso é
 * `motivoDaRecusaDaResposta` no worker, e não muda nada aqui.
 *
 * Puro determinístico: nenhuma chamada de rede, nenhuma de modelo. Quem
 * manda é `enviarPrivadaDeGatilho` (`./acao.ts`).
 */
import { z } from "zod";

/**
 * A chave do armazenamento é SEM acento de propósito: ela vira caminho em
 * `organizations.settings` (jsonb) e em corpo de request. O rótulo COM acento
 * é o que a trava devolve, e a tradução entre os dois mora só aqui.
 */
export const GATILHOS_QUE_ABREM_CONVERSA = {
  preço: "preco",
  agendamento: "agendamento",
} as const satisfies Record<string, string>;

export type ChaveDeGatilho = (typeof GATILHOS_QUE_ABREM_CONVERSA)[keyof typeof GATILHOS_QUE_ABREM_CONVERSA];

export type FrasesDeGatilho = Record<ChaveDeGatilho, string>;

/**
 * O texto que sai quando o dono não configurou nada. As duas terminam em
 * PERGUNTA: pedido do dono, e é o que transforma um aviso numa conversa —
 * mensagem que só se apresenta não recebe resposta.
 *
 * Nenhuma cita valor. Preço em mensagem automática vira promessa, e quem
 * responde sobre preço é o dono, no privado, depois que a conversa começou.
 */
export const FRASES_PADRAO: FrasesDeGatilho = {
  preco:
    "Olá! Tudo bom? Dei uma lida no seu comentário, deixa eu só fazer uma pergunta. Hoje em dia, o que você realmente busca? Seu maior objetivo?",
  agendamento:
    "Olá! Tudo bom? Vi que você quer marcar uma consulta. Deixa eu te perguntar uma coisa antes: o que te fez procurar agora?",
};

/** O rótulo da trava abre conversa? Qualquer outro rótulo devolve `false`. */
export function abreConversa(gatilho: string): gatilho is keyof typeof GATILHOS_QUE_ABREM_CONVERSA {
  return Object.prototype.hasOwnProperty.call(GATILHOS_QUE_ABREM_CONVERSA, gatilho);
}

/** A chave de armazenamento de um rótulo que já passou por `abreConversa`. */
export function chaveDoGatilho(gatilho: keyof typeof GATILHOS_QUE_ABREM_CONVERSA): ChaveDeGatilho {
  return GATILHOS_QUE_ABREM_CONVERSA[gatilho];
}

const Esquema = z
  .object({ preco: z.string().optional(), agendamento: z.string().optional() })
  .catch({});

/**
 * As frases em vigor, a partir do que estiver guardado na organização.
 *
 * Tolerante de propósito, nos dois sentidos: um valor de tipo errado ou um
 * campo em branco caem no padrão em vez de derrubar a rodada ou — pior —
 * mandar uma mensagem vazia para alguém interessado em comprar. Apagar o
 * texto na tela não é "não mandar nada"; quem não quer mandar desliga o
 * gatilho, e desligar ainda não existe (ver `.changes/`).
 */
export function frasesDeGatilho(bruto: unknown): FrasesDeGatilho {
  const lido = Esquema.parse(bruto ?? {});
  const escolher = (valor: string | undefined, padrao: string): string => {
    const aparado = valor?.trim();
    return aparado ? aparado : padrao;
  };
  return {
    preco: escolher(lido.preco, FRASES_PADRAO.preco),
    agendamento: escolher(lido.agendamento, FRASES_PADRAO.agendamento),
  };
}
