/**
 * SEGURANÇA DE PUBLICAÇÃO AUTÔNOMA — a régua conservadora, num lugar só.
 *
 * Esta função decide se uma IA pode publicar sozinha, em público e assinando
 * como o dono do perfil — que é MÉDICO — uma resposta a um comentário. Se ela
 * deixar passar o que não devia, sai no Instagram uma resposta sobre dose,
 * preço ou sintoma assinada por um médico. Na dúvida, é sempre "precisa de um
 * humano": a regra final é restritiva, não permissiva.
 *
 * Determinístico, não IA: uma lista de gatilhos e um punhado de padrões
 * seguros. O motivo: uma IA julgando o que é seguro pode ser convencida por um
 * texto; uma lista não — e o dono edita a lista sem publicar versão nova.
 *
 * ═══ RONDA 1 (revisão): "obviamente seguro" era SUBSTRING, não o texto todo ═══
 *
 * A primeira versão testava se o comentário CONTINHA um elogio em algum
 * lugar. Isso inverte a polaridade da trava: "amei, posso tomar mounjaro?"
 * contém "amei", então "casava um padrão seguro" — e a IA publicaria, em
 * público, assinando como médico, uma resposta sobre medicação. A prova de
 * mutação confirmou: apagando a tabela `GATILHOS` inteira, a suíte antiga
 * continuava verde, porque nenhum dos textos inseguros testados tinha a
 * palavra "amei" dentro — o furo real (elogio + assunto clínico) não tinha
 * cobertura nenhuma.
 *
 * A correção é a mesma lição de `ehPalavraIsolada` em `lib/opt-out/deteccao.ts`
 * — o arquivo que este módulo espelha: lá, "parar" só conta se for a MENSAGEM
 * INTEIRA (ou verbo + objeto de comunicação), nunca a palavra solta no meio da
 * frase. Aqui, "obviamente seguro" só pode significar "o comentário INTEIRO é
 * elogio ou emoji" — nunca "contém um elogio". `GATILHOS` continua existindo,
 * mas agora é a SEGUNDA linha de defesa (e o rótulo específico do motivo);
 * quem impede a publicação por padrão é a ausência de casamento com a lista
 * fechada de frases seguras, não a presença de um gatilho.
 */

import { normalizarTexto } from "../opt-out/deteccao";

export type Veredito = { seguro: true } | { seguro: false; gatilho: string };

/** Acima disso não é "obviamente seguro" — elogio não cabe num parágrafo. */
const LIMITE_TAMANHO = 60;

/**
 * Gatilhos por assunto: qualquer casamento aqui é "precisa de um humano", e dá
 * o rótulo específico do motivo. Cobre português e o vocabulário inequívoco em
 * espanhol (o CRM atende nos dois idiomas). Cada padrão é ancorado (`\b`) para
 * não pegar substring dentro de outra palavra.
 */
const GATILHOS: ReadonlyArray<[string, RegExp]> = [
  [
    "preço",
    /\b(quanto\s+custa|valor|preco|precos|custa|desconto|promocao|cuanto\s+cuesta|precio)\b/u,
  ],
  [
    "medicação",
    /\b(mounjaro|tirzepatida|ozempic|semaglutida|saxenda|liraglutida|remedio|medicamento|medicacao|dose|dosagem|posologia|bula|puedo\s+tomar)\b/u,
  ],
  [
    "sintoma",
    /\b(sintoma|sintomas|tontura|dor|nausea|enjoo|efeito\s+colateral|reacao|tireoide|normal\s+isso|serve\s+pra|serve\s+para|diabetico|diabetica|amamentando)\b/u,
  ],
  ["agendamento", /\b(agend\w*|horario|marcar|consulta|disponibilidade|cita|agendar)\b/u],
  ["reclamação", /\b(golpe|paguei|pagamento|reembolso|estorno|cancelamento|nao\s+respond\w*|absurdo|revoltante)\b/u],
  [
    "especialidade",
    /\b(nutrologo|nutrologa|nutriologo|nutriologa|especialista|especialidade|rqe|voce\s+e\s+medico|voce\s+e\s+nutrologo|eres\s+nutriologo)\b/u,
  ],
];

/** Emoji "de verdade" — inclui variation selector (❤️), ZWJ e tom de pele (👨🏽‍⚕️). */
const EMOJI_CLASSE =
  "\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\u{FE0F}\\u{200D}\\u{1F3FB}-\\u{1F3FF}";
const SOMENTE_EMOJI_RE = new RegExp(`^[${EMOJI_CLASSE}\\s]+$`, "u");
const BORDA_EMOJI_RE = new RegExp(`^[${EMOJI_CLASSE}\\s]+|[${EMOJI_CLASSE}\\s]+$`, "gu");

/** Pontuação que não muda o sentido do elogio e não deveria impedir o casamento. */
const PONTUACAO_RE = /[!?.,;:()"'«»""''…-]/gu;

/**
 * Frases INTEIRAS que valem como "obviamente seguro" — nunca substring. É essa
 * lista fechada, e não `GATILHOS`, que decide o padrão a favor; qualquer coisa
 * fora dela (por mais elogio que comece) é `{ seguro: false }`.
 */
const FRASES_DE_ELOGIO: ReadonlySet<string> = new Set([
  "top",
  "show",
  "otimo",
  "otima",
  "maravilhoso",
  "maravilhosa",
  "incrivel",
  "sensacional",
  "parabens",
  "parabens doutor",
  "parabens doutora",
  "amei",
  "adorei",
  "obrigado",
  "obrigada",
  "gratidao",
  "que video bom",
  "que video otimo",
  "que video top",
  "que video incrivel",
  "que post bom",
  "que post otimo",
  "que post top",
  "que conteudo bom",
  "que conteudo otimo",
  "que conteudo top",
]);

/** Remove pontuação e colapsa espaços — só para o casamento contra `FRASES_DE_ELOGIO`. */
function textoLimpo(normalizado: string): string {
  return normalizado.replace(PONTUACAO_RE, "").replace(/\s+/gu, " ").trim();
}

/** O texto INTEIRO (tirando colar de emoji e espaço nas bordas) é elogio, ou é só emoji? */
function ehElogioOuEmoji(limpo: string): boolean {
  if (limpo === "") return false;
  if (SOMENTE_EMOJI_RE.test(limpo)) return true;
  const nucleo = limpo.replace(BORDA_EMOJI_RE, "").trim();
  return FRASES_DE_ELOGIO.has(nucleo);
}

export function ehObviamenteSeguro(texto: string | null): Veredito {
  if (!texto || texto.trim() === "") {
    return { seguro: false, gatilho: "vazio" };
  }

  const textoAparado = texto.trim();
  const normalizado = normalizarTexto(textoAparado);

  for (const [gatilho, padrao] of GATILHOS) {
    if (padrao.test(normalizado)) {
      return { seguro: false, gatilho };
    }
  }

  if (textoAparado.length > LIMITE_TAMANHO) {
    return { seguro: false, gatilho: "texto longo demais" };
  }

  if (normalizado.endsWith("?")) {
    return { seguro: false, gatilho: "pergunta" };
  }

  if (ehElogioOuEmoji(textoLimpo(normalizado))) {
    return { seguro: true };
  }

  return { seguro: false, gatilho: "sem padrão seguro reconhecido" };
}
