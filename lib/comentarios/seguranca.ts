/**
 * SEGURANÇA DE PUBLICAÇÃO AUTÔNOMA — a régua conservadora, num lugar só.
 *
 * Esta função decide se uma IA pode publicar sozinha, em público e assinando
 * como o dono do perfil — que é MÉDICO — uma resposta a um comentário. Se ela
 * deixar passar o que não devia, sai no Instagram uma resposta sobre dose,
 * preço ou sintoma assinada por um médico. Na dúvida, é sempre "precisa de um
 * humano": a regra final é restritiva, não permissiva.
 *
 * Espelha `lib/opt-out/deteccao.ts`: mesma normalização (minúsculas, sem
 * acento), mesmo estilo de vocabulário em listas/regex nomeadas — porque
 * aquele arquivo já aprendeu, na prática, que "palavra solta" produz falso
 * positivo, e essa lição vale aqui também.
 *
 * Determinístico, não IA: uma lista de gatilhos e um punhado de padrões
 * seguros. O motivo: uma IA julgando o que é seguro pode ser convencida por um
 * texto; uma lista não — e o dono edita a lista sem publicar versão nova.
 */

export type Veredito = { seguro: true } | { seguro: false; gatilho: string };

/** minúsculas, sem acento — mesma normalização de `lib/opt-out/deteccao.ts`. */
function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "");
}

/**
 * Gatilhos por assunto: qualquer casamento aqui é "precisa de um humano".
 * Cada padrão é ancorado (`\b`) para não pegar substring dentro de outra
 * palavra — a mesma proteção contra falso positivo que motivou este arquivo.
 */
const GATILHOS: ReadonlyArray<[string, RegExp]> = [
  ["preço", /\b(quanto\s+custa|valor|preco|custa|desconto|promocao)\b/u],
  [
    "medicação",
    /\b(mounjaro|tirzepatida|ozempic|semaglutida|saxenda|liraglutida|remedio|medicamento|medicacao|dose|dosagem|posologia|bula)\b/u,
  ],
  [
    "sintoma",
    /\b(sintoma|sintomas|tontura|dor|nausea|enjoo|efeito\s+colateral|reacao|tireoide|normal\s+isso|serve\s+pra|serve\s+para)\b/u,
  ],
  ["agendamento", /\b(agend\w*|horario|marcar|consulta|disponibilidade)\b/u],
  ["reclamação", /\b(golpe|paguei|pagamento|reembolso|estorno|cancelamento|nao\s+respond\w*|absurdo|revoltante)\b/u],
  [
    "especialidade",
    /\b(nutrologo|nutrologa|especialista|especialidade|rqe|voce\s+e\s+medico|voce\s+e\s+nutrologo)\b/u,
  ],
];

/**
 * Padrões seguros: elogio curto, emoji, interjeição — o único terreno em que
 * uma publicação automática é aceitável. Curto de propósito: qualquer coisa
 * fora desta lista não é "obviamente seguro".
 */
const PADROES_SEGUROS: readonly RegExp[] = [
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u,
  /\b(top|show|otimo|otima|maravilhoso|maravilhosa|incrivel|sensacional|parabens|amei|adorei|obrigad[ao]|gratid[aã]o)\b/u,
  /\b(que\s+(video|post|conteudo)\s+(bom|otimo|top|incrivel))\b/u,
];

export function ehObviamenteSeguro(texto: string | null): Veredito {
  if (!texto || texto.trim() === "") {
    return { seguro: false, gatilho: "vazio" };
  }

  const normalizado = normalizarTexto(texto.trim());

  for (const [gatilho, padrao] of GATILHOS) {
    if (padrao.test(normalizado)) {
      return { seguro: false, gatilho };
    }
  }

  const terminaEmPergunta = normalizado.endsWith("?");
  const casaPadraoSeguro = PADROES_SEGUROS.some((padrao) => padrao.test(normalizado));

  if (casaPadraoSeguro && !terminaEmPergunta) {
    return { seguro: true };
  }

  return { seguro: false, gatilho: "sem padrão seguro reconhecido" };
}
