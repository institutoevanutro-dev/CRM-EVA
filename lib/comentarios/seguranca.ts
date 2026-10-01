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
 * Marcação de perfil do Instagram: `@` seguido do identificador (letras,
 * dígitos, ponto, sublinhado), e só quando o `@` NÃO vem colado em
 * letra/dígito — senão `joao@clinica.com` viraria "fale com", e um e-mail no
 * comentário passaria a ser invisível para a trava.
 */
const MARCACAO_RE = /(^|[^\p{L}\p{N}])@[\p{L}\p{N}._]+/gu;

/**
 * Tira as marcações ANTES de julgar. O `$1` devolve o separador que a regex
 * consumiu, para `"@fulano, top!"` virar `", top!"` e não `" top!"` colado no
 * que veio antes.
 *
 * O texto guardado em `instagram_comments.texto` e o que a tela mostra NUNCA
 * passam por aqui: quem escreveu escreveu.
 */
function semMarcacoes(texto: string): string {
  return texto.replace(MARCACAO_RE, "$1");
}

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

/**
 * O token já é conhecido pela trava (vocabulário fixo, emoji ou dígito)? É a
 * ÚNICA definição de "conhecido": `todosOsTokensSaoSeguros` e os candidatos a
 * aprovação usam esta mesma expressão, para não divergirem.
 */
export function ehTokenConhecido(token: string): boolean {
  return (
    SOMENTE_EMOJI_RE.test(token) ||
    SOMENTE_DIGITOS_RE.test(token) ||
    VOCABULARIO_SEGURO.has(token)
  );
}

/**
 * O token, sozinho, casa algum dos seis gatilhos? Usado para NUNCA oferecer
 * palavra de gatilho ao dono: pedir que ele libere "custa" enquanto limpa a
 * fila é pedir que desarme a própria proteção sem perceber.
 */
export function ehTokenDeGatilho(token: string): boolean {
  // Os padrões não têm flag `g`, então `lastIndex` não importa; o reset é
  // por segurança caso alguém acrescente `g` no futuro.
  const sozinho = GATILHOS.some(([, padrao]) => {
    padrao.lastIndex = 0;
    return padrao.test(token);
  });
  return sozinho || COMPONENTES_DE_GATILHO.some((c) => c.test(token));
}

/**
 * Pedaços das alternativas multipalavra dos gatilhos ("voce e medico" vira
 * "voce", "e", "medico"), DERIVADOS de `GATILHOS` e não escritos à mão: gatilho
 * novo entra aqui sozinho. Um componente aprovado não desarma o gatilho (a
 * trava roda sobre o texto inteiro), mas oferecê-lo ao dono é oferecer a
 * metade de uma proteção, então nunca se oferece.
 */
const COMPONENTES_DE_GATILHO: readonly RegExp[] = GATILHOS.flatMap(([, padrao]) => {
  const miolo = padrao.source.replace(/^\\b\(/, "").replace(/\)\\b$/, "");
  return miolo
    .split("|")
    .filter((alt) => alt.includes("\\s+"))
    .flatMap((alt) => alt.split("\\s+"))
    .map((pedaco) => new RegExp(`^(?:${pedaco})$`, "u"));
});

/** Tokens do texto, já sem marcação e normalizados: a MESMA régua da trava. */
export function tokensParaAnalise(texto: string): string[] {
  return normalizarTexto(semMarcacoes(texto).trim()).match(TOKEN_RE) ?? [];
}

/** Todo token do texto está no vocabulário seguro (ou é emoji/dígito)? Um único de fora já reprova o texto inteiro. */
function todosOsTokensSaoSeguros(
  normalizado: string,
  aprovadas: ReadonlySet<string>,
): boolean {
  const tokens = normalizado.match(TOKEN_RE) ?? [];
  if (tokens.length === 0) return false;
  return tokens.every((token) => ehTokenConhecido(token) || aprovadas.has(token));
}

const NENHUMA_APROVADA: ReadonlySet<string> = new Set();

/**
 * `aprovadas` são as palavras que o DONO liberou (tabela
 * `instagram_comment_vocabulario`, por organização). Entram por argumento, e
 * não por consulta aqui dentro, porque esta função é pura de propósito: ela é
 * a régua, e régua que faz I/O não dá para testar com 40 frases num teste de
 * unidade.
 *
 * Elas só participam da ÚLTIMA pergunta ("todo token é conhecido?"). Os
 * gatilhos, o teto de tamanho e a interrogação final rodam antes e não olham
 * para este conjunto.
 *
 * CONTRATO: `aprovadas` tem de vir com as palavras JÁ normalizadas pela mesma
 * `normalizarTexto` de `lib/opt-out/deteccao.ts` (minúsculas, sem acento). A
 * comparação é exata contra o token normalizado e esta função NÃO normaliza o
 * conjunto (alocaria um `Set` por comentário). Palavra fora dessa forma, como
 * "Fantástico", nunca casa: ninguém recebe erro e a aprendizagem fica morta em
 * silêncio. Quem grava (Tarefa 5) e quem lê (Tarefa 6) garantem a forma.
 */
export function ehObviamenteSeguro(
  texto: string | null,
  aprovadas: ReadonlySet<string> = NENHUMA_APROVADA,
): Veredito {
  if (!texto || texto.trim() === "") {
    return { seguro: false, gatilho: "vazio" };
  }

  const textoAparado = semMarcacoes(texto).trim();
  if (textoAparado === "") {
    return { seguro: false, gatilho: "vazio" };
  }
  const normalizado = normalizarTexto(textoAparado);

  // Os gatilhos multipalavra usam `\s+`, e `normalizarTexto` preserva
  // pontuação: "voce, e medico" não casaria. Colapsa tudo que não é
  // letra/dígito em um espaço, SÓ para este laço (o teto de tamanho e a
  // interrogação final precisam do texto como veio).
  const paraGatilhos = normalizado.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  for (const [gatilho, padrao] of GATILHOS) {
    if (padrao.test(paraGatilhos)) {
      return { seguro: false, gatilho };
    }
  }

  if (textoAparado.length > LIMITE_TAMANHO) {
    return { seguro: false, gatilho: "texto longo demais" };
  }

  if (normalizado.endsWith("?")) {
    return { seguro: false, gatilho: "pergunta" };
  }

  if (todosOsTokensSaoSeguros(normalizado, aprovadas)) {
    return { seguro: true };
  }

  return { seguro: false, gatilho: "sem padrão seguro reconhecido" };
}
