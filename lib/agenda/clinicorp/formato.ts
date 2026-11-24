/**
 * O FORMATO do que a "Gestão de Webhook" da Clinicorp manda, sem um valor sequer.
 *
 * O payload desse webhook não tem documentação pública, e ele traz a agenda com
 * o paciente dentro. Antes de escrever o parser (migration 0434), o receptor só
 * MEDE: cada caminho do JSON vira uma linha `caminho: tipo`, e o tipo de texto é
 * uma CLASSE (data, hora, dígitos…) calculada do valor, nunca o valor.
 *
 * O que NUNCA sai daqui: texto livre, número, nome de chave que pareça dado
 * (só dígitos, com espaço, acento ou @ — a chave de um mapa por telefone ou por
 * nome seria o próprio dado). A única exceção é o NOME DO EVENTO
 * (`appointment_*`): é vocabulário da Clinicorp, e é ele que diz qual dos três
 * eventos cadastrados chegou.
 */
import { createHash } from "node:crypto";

const PROFUNDIDADE_MAXIMA = 8;
const LINHAS_MAXIMAS = 300;
const CABECALHOS_MAXIMOS = 40;
export const FORMATOS_GUARDADOS = 20;

/** Chave que é nome de campo, não dado: identificador ASCII curto, como `Dentist_PersonId`. */
const CHAVE_DE_CAMPO = /^[A-Za-z_$][\w$\-[\]]{0,63}$/;
const EVENTO = /^appointment_[a-z_]{1,40}$/;

function classeDoTexto(v: string): string {
  const s = v.trim();
  if (s === "") return "texto-vazio";
  if (EVENTO.test(s)) return `evento:${s}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "texto-data";
  const dataHora = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (dataHora) return dataHora[3] === "Z" ? "texto-data-hora-utc" : dataHora[3] ? "texto-data-hora-com-fuso" : "texto-data-hora-sem-fuso";
  if (/^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s)) return "texto-hora";
  if (/^\d+$/.test(s)) return `texto-digitos(${s.length})`;
  if (/^[A-Za-z]$/.test(s)) return "texto-uma-letra";
  return "texto";
}

function tipoDe(v: unknown): string {
  if (v === null || v === undefined) return "nulo";
  if (typeof v === "string") return classeDoTexto(v);
  if (typeof v === "number") return Number.isInteger(v) ? "numero-inteiro" : "numero-decimal";
  if (typeof v === "boolean") return "booleano";
  if (Array.isArray(v)) return "lista";
  if (typeof v === "object") return "objeto";
  return "outro";
}

const nomeDaChave = (k: string) => (CHAVE_DE_CAMPO.test(k) ? k : /^\d+$/.test(k) ? "<numero>" : "<chave>");

/**
 * `caminho: tipo` de cada nó, em ordem, sem repetição. Os itens de uma lista se
 * somam sob `[]`: o mesmo caminho com tipos diferentes vira `tipo1|tipo2`.
 */
export function descreverFormato(raiz: unknown): string[] {
  const tipos = new Map<string, Set<string>>();
  const visitar = (v: unknown, caminho: string, profundidade: number) => {
    if (tipos.size >= LINHAS_MAXIMAS) return;
    (tipos.get(caminho) ?? tipos.set(caminho, new Set()).get(caminho)!).add(tipoDe(v));
    if (profundidade >= PROFUNDIDADE_MAXIMA || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 50)) visitar(item, `${caminho}[]`, profundidade + 1);
      return;
    }
    for (const [k, filho] of Object.entries(v as Record<string, unknown>)) {
      visitar(filho, `${caminho}.${nomeDaChave(k)}`, profundidade + 1);
    }
  };
  visitar(raiz, "$", 0);
  // Ordem do CAMINHO (pai antes do filho), não da linha formatada: `:` vem depois de `.`.
  return [...tipos]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([c, t]) => `${c}: ${[...t].sort().join("|")}`);
}

export interface FormatoRecebido {
  /** sha256 curto de método + tipo de conteúdo + linhas: o mesmo formato soma `vezes`. */
  id: string;
  metodo: string;
  tipo_de_conteudo: string | null;
  /** Só os NOMES dos cabeçalhos. Valor de cabeçalho pode ser segredo. */
  cabecalhos: string[];
  linhas: string[];
  vezes: number;
  primeira_vez: string;
  ultima_vez: string;
}

/** Os nomes dos cabeçalhos, minúsculos e em ordem; nenhum valor. */
export function nomesDosCabecalhos(headers: Headers): string[] {
  return [...new Set([...headers.keys()].map((k) => k.toLowerCase()))]
    .filter((k) => CHAVE_DE_CAMPO.test(k))
    .sort()
    .slice(0, CABECALHOS_MAXIMOS);
}

/** Lê o corpo como o webhook o mandou: JSON, formulário, ou nada que se leia. */
export function lerCorpo(texto: string, tipoDeConteudo: string | null): unknown {
  if (texto.trim() === "") return null;
  if (tipoDeConteudo?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(texto));
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    // Não-JSON: o tipo diz que era texto; o texto não sai daqui.
    return "<corpo-que-nao-e-json>";
  }
}

/**
 * A lista guardada com o formato novo somado: o mesmo formato ganha `vezes`, o
 * novo entra no topo, e só ficam os `FORMATOS_GUARDADOS` mais recentes.
 */
export function somarFormato(
  guardados: unknown,
  novo: { metodo: string; tipo_de_conteudo: string | null; cabecalhos: string[]; linhas: string[] },
  agora: Date,
): FormatoRecebido[] {
  const lista = Array.isArray(guardados) ? (guardados as FormatoRecebido[]) : [];
  const id = createHash("sha256")
    .update(JSON.stringify([novo.metodo, novo.tipo_de_conteudo, novo.linhas]))
    .digest("hex")
    .slice(0, 12);
  const quando = agora.toISOString();
  const anterior = lista.find((f) => f.id === id);
  const atual: FormatoRecebido = anterior
    ? { ...anterior, cabecalhos: novo.cabecalhos, vezes: anterior.vezes + 1, ultima_vez: quando }
    : { id, ...novo, vezes: 1, primeira_vez: quando, ultima_vez: quando };
  return [atual, ...lista.filter((f) => f.id !== id)].slice(0, FORMATOS_GUARDADOS);
}
