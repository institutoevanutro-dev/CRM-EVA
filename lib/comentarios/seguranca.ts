/**
 * SEGURANÇA DE PUBLICAÇÃO AUTÔNOMA — a régua conservadora, num lugar só.
 *
 * Esta função decide se uma IA pode publicar sozinha, em público e assinando
 * como o dono do perfil — que é MÉDICO — uma resposta a um comentário. Se ela
 * deixar passar o que não devia, sai no Instagram uma resposta sobre dose,
 * preço ou sintoma assinada por um médico. Na dúvida, é sempre "precisa de um
 * humano": a regra final é restritiva, não permissiva.
 *
 * Determinístico, não IA: uma lista de gatilhos e um vocabulário seguro
 * fechado. O motivo: uma IA julgando o que é seguro pode ser convencida por um
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
 * cobertura nenhuma. A correção foi ancorar ao texto INTEIRO — a mesma lição
 * de `ehPalavraIsolada` em `lib/opt-out/deteccao.ts`: lá, "parar" só conta se
 * for a MENSAGEM INTEIRA, nunca a palavra solta no meio da frase.
 *
 * ═══ RONDA 2 (revisão): ancorar a uma LISTA DE FRASES fechadas superprotegeu ═══
 *
 * O ancoramento ao texto inteiro resolveu a segurança — zero perigoso vazava
 * —, mas o critério de "seguro" era casar uma das frases inteiras de uma
 * lista fechada (`FRASES_DE_ELOGIO`). Elogio de verdade não sai só nessas
 * frases: "muito bom esse conteúdo", "excelente explicação", "melhor
 * explicação que já vi" são elogio legítimo, sem risco nenhum, e todos
 * caíam em `seguro: false` — metade dos elogios reais medidos. Isso é pior do
 * que não ter a trava: enche a fila humana de "amei o conteúdo" para revisar.
 *
 * A correção não é afrouxar o ancoramento — é trocar o CRITÉRIO do que conta
 * como elogio. Em vez de "o texto inteiro é UMA DAS frases da lista", agora é
 * "TODO TOKEN do texto está no vocabulário seguro" (elogio, cola sem
 * conteúdo, como chamam o dono — nunca título de especialidade — emoji,
 * pontuação e número solto). Continua sendo ancoragem ao texto inteiro (deny-
 * by-default: um único token desconhecido, como "caneta" ou "preço", já
 * reprova o texto inteiro), só que a unidade de casamento é a PALAVRA, não a
 * frase pronta — o que deixa o vocabulário compor infinitas frases de elogio
 * sem abrir mão de barrar qualquer assunto clínico, comercial ou de
 * agendamento que apareça junto.
 */

import { normalizarTexto } from "../opt-out/deteccao";

export type Veredito = { seguro: true } | { seguro: false; gatilho: string };

/** Acima disso não é "obviamente seguro" — elogio não cabe num parágrafo. */
const LIMITE_TAMANHO = 120;

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
const SOMENTE_EMOJI_RE = new RegExp(`^[${EMOJI_CLASSE}]+$`, "u");
const SOMENTE_DIGITOS_RE = /^\d+$/u;

/** Corta o texto em tokens: sequência de letras/dígitos, OU sequência de emoji. Pontuação some sozinha (não casa nenhuma alternativa). */
const TOKEN_RE = new RegExp(`[\\p{L}\\p{N}]+|[${EMOJI_CLASSE}]+`, "gu");

/**
 * Vocabulário seguro — a unidade de casamento é a PALAVRA, não a frase. Todo
 * token do comentário precisa estar aqui (ou ser emoji/dígito) para o texto
 * inteiro contar como elogio. Três famílias, deliberadamente separadas para
 * ficar claro o que cada uma autoriza:
 *
 * - ELOGIO: a palavra que carrega o sentimento positivo.
 * - COLA_SEM_CONTEUDO: liga a frase mas não decide nada sozinha ("de", "que",
 *   "o"...) — inclui os substantivos genéricos que só apontam pro post em si
 *   ("vídeo", "post", "conteúdo", "explicação"), nunca pro tratamento.
 * - COMO_CHAMAM_O_DONO: só o tratamento social. **Nunca título de
 *   especialidade** ("nutrólogo", "especialista") — o dono não tem RQE, e
 *   essa linha NÃO entra aqui de propósito (fica coberta por `GATILHOS`,
 *   categoria "especialidade", que roda antes desta lista).
 */
const ELOGIO = [
  "top", "amei", "amo", "adoro", "adorei", "parabens", "show", "sensacional",
  "maravilhoso", "maravilhosa", "perfeito", "perfeita", "excelente",
  "otimo", "otima", "bom", "boa", "bons", "boas", "melhor", "incrivel",
  "lindo", "linda", "lindos", "lindas", "gratidao", "obrigado", "obrigada",
  "sucesso", "arrasou", "arrasa", "demais", "gente", "nossa", "uau",
];
const COLA_SEM_CONTEUDO = [
  "o", "a", "os", "as", "esse", "essa", "este", "esta", "isso", "que",
  "de", "do", "da", "muito", "mais", "tudo", "sempre", "ja", "vi", "e",
  "pra", "seu", "sua", "bola",
  // assunto genérico do post — aponta pro conteúdo, não pro tratamento
  "video", "post", "conteudo", "explicacao", "dica", "aula",
];
const COMO_CHAMAM_O_DONO = ["doutor", "dr", "doutora", "dra"];

const VOCABULARIO_SEGURO: ReadonlySet<string> = new Set([
  ...ELOGIO,
  ...COLA_SEM_CONTEUDO,
  ...COMO_CHAMAM_O_DONO,
]);

/** Todo token do texto está no vocabulário seguro (ou é emoji/dígito)? Um único de fora já reprova o texto inteiro. */
function todosOsTokensSaoSeguros(normalizado: string): boolean {
  const tokens = normalizado.match(TOKEN_RE) ?? [];
  if (tokens.length === 0) return false;
  return tokens.every(
    (token) =>
      SOMENTE_EMOJI_RE.test(token) || SOMENTE_DIGITOS_RE.test(token) || VOCABULARIO_SEGURO.has(token),
  );
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

  if (todosOsTokensSaoSeguros(normalizado)) {
    return { seguro: true };
  }

  return { seguro: false, gatilho: "sem padrão seguro reconhecido" };
}
