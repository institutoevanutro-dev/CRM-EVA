/**
 * Scrub compartilhado da telemetria (issue #100).
 *
 * Este arquivo existe porque a lógica anterior vivia TRIPLICADA, verbatim, em
 * `sentry.server.config.ts`, `sentry.edge.config.ts` e `instrumentation-client.ts`.
 * Foi exatamente essa triplicação que produziu o buraco: o `beforeSend` cobria
 * erro e mensagem nos três, e ninguém percebeu que transação, span e breadcrumb
 * têm hooks PRÓPRIOS — que não existiam em lugar nenhum. Com `tracesSampleRate: 1`,
 * o canal sem sanitização era justamente o de 100% de amostragem.
 *
 * Agora há um ponto só. Quem adicionar um hook novo adiciona para os três runtimes.
 */

/**
 * Tipos estruturais mínimos, em vez de importar de `@sentry/core`.
 *
 * `SpanJSON` e `TransactionEvent` não são reexportados por `@sentry/nextjs`, e o
 * `@sentry/core` é dependência TRANSITIVA — sob o node_modules estrito do pnpm ele
 * não resolve a partir da raiz. Importar dele funcionaria na máquina de quem tem
 * hoisting e quebraria no CI. Declarar só os campos que este arquivo toca mantém os
 * hooks atribuíveis ao `Sentry.init` por compatibilidade estrutural, sem acoplar a
 * um pacote que não é dependência direta.
 */
type EventLike = {
  // `unknown` de propósito nos campos que o Sentry tipa mais largo que string
  // (`query_string` é `string | Record<string,string> | Array<[string,string]>`).
  // A checagem de `typeof === "string"` acontece em runtime, logo abaixo.
  request?: { url?: unknown; query_string?: unknown; headers?: unknown };
  transaction?: string;
  contexts?: { trace?: { data?: Record<string, unknown> } };
  message?: string;
  exception?: { values?: Array<{ value?: string }> };
  extra?: unknown;
  user?: unknown;
};
type SpanLike = { description?: string; data?: Record<string, unknown> };
type BreadcrumbLike = { category?: string; message?: string; data?: Record<string, unknown> };

/**
 * Header sensível por PADRÃO, não por lista fechada.
 *
 * A lista anterior enumerava os headers de cada integração pelo nome. Isso tem dois
 * defeitos: header de integração nova entra vazando até alguém lembrar de somar à
 * lista, e o arquivo passa a nomear provider — o que a doutrina de restrição de canal
 * proíbe fora de `lib/channels/` (`docs/doctrine/restricao-de-canal.md`). Casar pelo
 * que torna o header sensível cobre os dois casos de uma vez.
 */
const SENSITIVE_HEADER = /authorization|cookie|api[-_]?key|token|secret|password|credential/i;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

/**
 * Identificador de depuração reconhecido pela FORMA, não dado do titular. Eles
 * são separados do texto ANTES dos padrões de CPF e telefone, que por isso não
 * precisam de borda de letra: com a borda, o número grudado no rótulo
 * (`cpf12345678909`, `tel-11987654321`) saía inteiro; sem ela e sem esta
 * separação, os padrões comeriam pedaço de UUID e — medido — de 597 em 5.000
 * sha256. O grupo de captura (um só) faz o `split` devolver o identificador nas
 * posições ímpares.
 *
 * São quatro formas, cada uma medida saindo furada antes de entrar aqui:
 *   - UUID (8-4-4-4-12 em hexadecimal);
 *   - hash em hexadecimal corrido de 32 ou mais (md5, sha1, sha256);
 *   - id em hexadecimal mais CURTO que um hash — ObjectId de 24, id de trace de
 *     16, sha de git — que saía como `5f8d04b[PHONE]a2b3c4`. Precisa estar
 *     isolado (sem letra nem dígito vizinho) e ter ao menos uma letra: onze
 *     dígitos puros são CPF ou celular. E não pode ter a forma "letras e depois
 *     só números", que é rótulo grudado (`cafe11987654321`), não id;
 *   - endereço IPv4: `192.168.100.10` tem a forma do CPF só com pontos. Um CPF
 *     escrito assim tem bloco acima de 255 em 98% dos casos; o resto é o preço.
 */
const OCTETO = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const IDENTIFICADOR = new RegExp(
  "(" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" +
    "|[0-9a-f]{32,}" +
    "|(?<![0-9a-z])(?=\\d*[a-f])(?![a-f]+\\d+(?![0-9a-z]))[0-9a-f]{12,31}(?![0-9a-z])" +
    `|(?<![\\d.])(?:${OCTETO}\\.){3}${OCTETO}(?![\\d.])` +
    ")",
  "i",
);

/**
 * Telefone como se escreve. Cada alternativa é um jeito medido:
 *
 *   1. BR com DDD: `+55 (11) 9 8765-4321`, `(21) 3456-7890`, `5511987654321`,
 *      com hífen, ponto, espaço ou nada entre os blocos;
 *   2. BR sem DDD (`98765-4321`, `3456-7890`) — aqui o separador é OBRIGATÓRIO:
 *      oito dígitos corridos são limite de tokens, id de pedido, contagem
 *      (`rate limit: 40000000 tokens` saía `[PHONE] tokens`);
 *   3. DDD e o número em trios (`27 999 991 234`) ou com o hífen fora do lugar
 *      (`(27) 9999-91234`);
 *   4. de fora do Brasil, quando o `+` na frente diz que é telefone
 *      (`+351 912 345 678`, `+1 (415) 555-2671`).
 *
 * As bordas `(?<![\w-])`/`(?![\w-])` são o que o tira de dentro de hash, de
 * data e de nome de modelo (`…-sonnet-20241022`).
 */
const DDD = "(?:\\(\\d{2}\\)|\\d{2})";
const TELEFONE = new RegExp(
  "(?<![\\w-])(?:" +
    `(?:\\+?\\d{2,3}[\\s.-]?)?${DDD}[\\s.-]?(?:9[\\s.-]?)?\\d{4}[\\s.-]?\\d{4}` +
    "|(?:9[\\s.-]?)?\\d{4}[\\s.-]\\d{4}" +
    `|${DDD}[\\s.-]?(?:\\d{3}[\\s.-]\\d{3}[\\s.-]\\d{3}|\\d{4}[\\s.-]\\d{5})` +
    "|\\+\\d{1,3}[\\s.-]?(?:\\(\\d{1,4}\\)|\\d{1,4})(?:[\\s.-]?\\d{2,4}){2,3}" +
    ")(?![\\w-])",
  "g",
);

/**
 * O número com DDD GRUDADO num rótulo (`zap11987654321`, `tel-5511987654321`,
 * `zap(85) 3110-7016`), que a borda de cima deixa passar. É a alternativa 1 de
 * `TELEFONE` com outra borda: só exige que o vizinho não seja outro dígito. Um
 * código numérico mais longo que um telefone fica inteiro, em vez de sair meio
 * apagado (`[PHONE]2345`) — que não protege o titular nem deixa depurar.
 */
const TELEFONE_GRUDADO = new RegExp(
  `(?<!\\d)(?:\\+?55[\\s.-]?)?${DDD}[\\s.-]?(?:9[\\s.-]?)?\\d{4}[\\s.-]?\\d{4}(?!\\d)`,
  "g",
);

/**
 * CPF com qualquer separador entre os blocos: `123 456 789 09` e
 * `123.456.789.09` também são CPF de quem digita rápido, e `123.456.789/09`,
 * `123,456,789-09` e `123 . 456 . 789 - 09` de quem erra a máscara. A vírgula
 * só vale COLADA: "768, 512, 256, 64" é lista de números, não CPF.
 * Mesma borda só de dígito, pelo mesmo motivo.
 */
const SEP = "(?:\\s?[./-]\\s?|,|\\s)?";
const CPF = new RegExp(`(?<!\\d)\\d{3}${SEP}\\d{3}${SEP}\\d{3}${SEP}\\d{2}(?!\\d)`, "g");

export function scrubMessage(input: string): string {
  return input
    // E-mail antes dos números: senão o telefone comia a parte numérica do
    // endereço (`11987654321@…`) e o domínio seguia inteiro.
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]")
    .split(IDENTIFICADOR)
    .map((trecho, i) => (i % 2 === 1 ? trecho : apagarCpfETelefone(trecho)))
    .join("");
}

function apagarCpfETelefone(trecho: string): string {
  // Telefone primeiro: 11 dígitos crus são ambíguos (CPF ou celular) e caem em
  // [PHONE] — redigidos de um jeito ou de outro. O CPF com pontuação não tem
  // quatro dígitos seguidos, então nenhum padrão de telefone o alcança.
  return trecho
    .replace(TELEFONE, "[PHONE]")
    .replace(TELEFONE_GRUDADO, "[PHONE]")
    .replace(CPF, "[CPF]");
}

/**
 * Rotas cujo último segmento é CREDENCIAL, não identificador.
 *
 * Os ~134 segmentos `[id]` do app são UUID e ficam de fora de propósito: redigir
 * tudo cegamente tornaria o Sentry inútil para depurar, que é o oposto do objetivo.
 * Estes são diferentes — o token É o mecanismo de autenticação:
 *
 *   /api/v1/webhooks/<canal>/<token>  — a variante por tenant é pública por desenho
 *     (o Caddyfile diz isso com todas as letras) e se apoia em o token ser
 *     imprevisível. Pior: a exigência de assinatura nasce desligada, porque nem todo
 *     transporte assina — então na instalação padrão o token do path é a credencial
 *     INTEIRA daquela rota. Publicá-lo na telemetria a anula.
 *   /team/accept-invite/<token>       — link de convite, aberto no browser.
 *
 * O segmento do canal é `[^/]+` de propósito, não uma lista: canal novo ganha a
 * proteção sozinho, e este arquivo não precisa nomear provider (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`).
 */
const CREDENTIAL_PATH =
  /(\/api\/v1\/webhooks\/[^/?#\s]+\/|\/team\/accept-invite\/)[^/?#\s]+/g;

/** Parâmetro de query (ou de fragmento) que carrega credencial: `token_hash`, `code`… */
const CREDENTIAL_PARAM = /token|code|secret|password|otp|^sig$/i;

/**
 * A URL carrega credencial: no path (as rotas acima) ou num parâmetro com nome de
 * credencial. É o critério de quem NÃO pode gravar a URL crua (o Replay, em
 * `./replay`), não de quem a redige — `scrubUrl` apaga todo valor de query.
 */
export function urlComCredencial(input: string): boolean {
  if (input.search(CREDENTIAL_PATH) >= 0) return true;
  let url: URL;
  try {
    url = new URL(input, "http://x");
  } catch {
    return false;
  }
  const nomes = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()];
  return nomes.some((nome) => CREDENTIAL_PARAM.test(nome));
}

/**
 * Redige credencial de path e valor de query string, preservando as CHAVES da query.
 *
 * Manter as chaves é deliberado: `?cursor=[REDACTED]&limit=[REDACTED]` ainda diz o
 * que a requisição estava fazendo, que é o que serve para depurar. O valor é o que
 * pode carregar assinatura, token ou dado do titular.
 */
export function scrubUrl(input: string): string {
  const withoutToken = input.replace(CREDENTIAL_PATH, "$1[TOKEN]");
  // O `^` da alternância não é adorno: o Sentry preenche `request.query_string`
  // com a query CRUA, sem o `?` na frente (`sig=abc`, não `?sig=abc`). Sem ele a
  // assinatura sobrevivia nesse campo — medido, não suposto.
  const withoutQueryValues = withoutToken.replace(
    /(^|[?&])([^=&#\s]+)=[^&#\s]*/g,
    "$1$2=[REDACTED]",
  );
  return scrubMessage(withoutQueryValues);
}

/** Atributos de span/trace que carregam URL crua na convenção OpenTelemetry. */
const URL_ATTRIBUTES = [
  "url.full",
  "url.path",
  "url.query",
  "http.url",
  "http.target",
  "http.request.url",
];

function scrubAttributes(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of URL_ATTRIBUTES) {
    const value = data[key];
    if (typeof value === "string") data[key] = scrubUrl(value);
  }
}

function scrubHeaders(headers: unknown): void {
  if (!headers || typeof headers !== "object") return;
  const record = headers as Record<string, string>;
  for (const key of Object.keys(record)) {
    if (isSensitiveHeader(key)) delete record[key];
    // O `Referer` é a URL da página anterior — com o token dela, se tinha um.
    else if (/^referer$/i.test(key) && typeof record[key] === "string") {
      record[key] = scrubUrl(record[key]);
    }
  }
}

/**
 * Limpa os campos que carregam URL em QUALQUER evento — erro ou transação.
 * O nome da transação entra aqui porque o `@sentry/node` puro não parametriza a
 * rota; só o wrapper do Next parametriza, e nem todo caminho passa por ele.
 */
function scrubEventUrls<T extends EventLike>(event: T): T {
  if (event.request) {
    scrubHeaders(event.request.headers);
    if (typeof event.request.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubUrl(event.request.query_string);
    }
  }
  if (typeof event.transaction === "string") {
    event.transaction = scrubUrl(event.transaction);
  }
  scrubAttributes(event.contexts?.trace?.data);
  return event;
}

/**
 * Os quatro hooks, prontos para espalhar dentro do `Sentry.init` de cada runtime.
 * Espalhar o objeto inteiro é o ponto: adicionar um hook aqui cobre servidor, edge
 * e cliente de uma vez, sem depender de alguém lembrar dos três arquivos.
 */
export const sentryScrubHooks = {
  beforeSend<T extends EventLike>(event: T): T {
    scrubEventUrls(event);
    // `extra` e `user` são saco livre: quem chama `captureException(e, { extra })`
    // põe o que tiver à mão, e o SDK põe e-mail/IP em `user`. Nenhum dos dois é
    // necessário para ler um stack trace (M5).
    delete event.extra;
    delete event.user;
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    }
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) ex.value = scrubMessage(ex.value);
      }
    }
    return event;
  },

  beforeSendTransaction<T extends EventLike>(event: T): T {
    return scrubEventUrls(event);
  },

  beforeSendSpan<T extends SpanLike>(span: T): T {
    if (typeof span.description === "string") {
      span.description = scrubUrl(span.description);
    }
    scrubAttributes(span.data);
    return span;
  },

  beforeBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T | null {
    // Breadcrumb de console é cópia do que o código imprimiu — nome, telefone,
    // corpo de mensagem. Descartado inteiro, não "limpo" (M5).
    if (breadcrumb.category === "console") return null;
    if (typeof breadcrumb.message === "string") {
      breadcrumb.message = scrubUrl(breadcrumb.message);
    }
    // `from`/`to` são da navegação (troca de rota): a rota de onde se saiu pode
    // ter o token no path.
    const data = breadcrumb.data;
    for (const campo of ["url", "from", "to"]) {
      const valor = data?.[campo];
      if (data && typeof valor === "string") data[campo] = scrubUrl(valor);
    }
    return breadcrumb;
  },
};
