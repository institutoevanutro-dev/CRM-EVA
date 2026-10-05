/**
 * Os campos personalizados do contato como o TITULAR os lê no relatório de
 * acesso (LGPD Art. 18 II): com o nome do campo em vez da chave técnica, e SEM
 * CPF em claro.
 *
 * Portado do DeskcommCRM original (commits cb2c95b08 e fe6f768ef, de
 * melgarafael) e adaptado a este fork em dois pontos:
 *
 *  - O RÓTULO vem das definições de campo do funil padrão da organização
 *    (`crm_pipelines.settings.fields[]`, as mesmas que a ficha do contato usa),
 *    não das perguntas de um roteiro — este fork não tem roteiros. `endereco`
 *    é o campo fixo que a ficha grava (`EditContactDialog`). Chave sem
 *    definição vira texto legível ("cidade_natal" → "Cidade natal").
 *
 *  - O CPF não sai NEM no arquivo de dados. No original o PDF o omitia e o
 *    `data.json` o levava em claro; aqui a política é a do CPF do cadastro
 *    (`cpf_present`): o relatório diz que existe, nunca mostra o número.
 *
 * Sem importar o motor nem o client do banco: o worker de export carrega sob
 * tsx. A única importação é o validador de CPF do cadastro (zod puro).
 */
import { isValidCpf } from "@/lib/schemas/contacts";

export interface CampoLegivel {
  rotulo: string;
  valor: string;
}

interface Definicao {
  label: string;
  type: string;
  opcoes: Map<string, string>;
}

/** O que substitui um CPF achado no meio de um texto. */
export const CPF_OMITIDO = "[CPF omitido]";

/** Campos que a ficha grava fora das definições do funil. */
const ROTULOS_FIXOS: Record<string, string> = { endereco: "Endereço" };

/**
 * key → definição, lida de `crm_pipelines.settings` sem validar forma: definição
 * que o schema estrito recusaria ainda tem um rótulo que serve ao titular.
 */
export function definicoesDoFunil(settings: unknown): Map<string, Definicao> {
  const mapa = new Map<string, Definicao>();
  const fields = (settings as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return mapa;
  for (const f of fields) {
    const campo = f as { key?: unknown; label?: unknown; type?: unknown; options?: unknown } | null;
    if (typeof campo?.key !== "string" || mapa.has(campo.key)) continue;
    const opcoes = new Map<string, string>();
    if (Array.isArray(campo.options)) {
      for (const o of campo.options) {
        const opcao = o as { value?: unknown; label?: unknown } | null;
        if (typeof opcao?.value === "string" && typeof opcao.label === "string") opcoes.set(opcao.value, opcao.label);
      }
    }
    mapa.set(campo.key, {
      label: typeof campo.label === "string" && campo.label.trim() ? campo.label.trim() : legivel(campo.key),
      type: typeof campo.type === "string" ? campo.type : "text",
      opcoes,
    });
  }
  return mapa;
}

/** `modelo_interesse` → "Modelo interesse": para chave sem definição conhecida. */
export function legivel(chave: string): string {
  const texto = chave.replace(/[_-]+/g, " ").trim();
  return texto ? texto[0]!.toUpperCase() + texto.slice(1) : chave;
}

/** A chave anuncia CPF? `cpf`, `CPF`, `cpf_do_responsavel`, `cpf/cnpj`. */
function chaveDeCpf(chave: string): boolean {
  return /cpf/i.test(chave);
}

/**
 * O campo é de TELEFONE (pela chave ou pelo tipo declarado no funil)? Celular
 * com DDD tem onze dígitos, e um em cada cem fecha os dígitos verificadores de
 * um CPF — `27999990000` fecha. Num campo que se diz telefone, é telefone.
 */
function campoDeTelefone(chave: string, definicao: Definicao | undefined): boolean {
  return definicao?.type === "phone" || /tel|fone|phone|celular|whats|zap/i.test(chave);
}

/** Onze dígitos, com ou sem a pontuação de costume, sem dígito colado antes ou depois. */
const TRECHO_COM_CARA_DE_CPF = /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s/.]?\d{2}(?!\d)/g;

/**
 * Tira o CPF de um texto. Só some o que tem dígito verificador de CPF: telefone
 * e protocolo de onze dígitos ficam (um em cada cem coincide, e some junto —
 * alcançar demais aqui custa um número a menos; alcançar de menos é o CPF
 * impresso).
 */
export function semCpfNoTexto(texto: string): { texto: string; achou: boolean } {
  let achou = false;
  const limpo = texto.replace(TRECHO_COM_CARA_DE_CPF, (trecho) => {
    if (!isValidCpf(trecho)) return trecho;
    achou = true;
    return CPF_OMITIDO;
  });
  return { texto: limpo, achou };
}

const REMOVER = Symbol("remover");

/** Percorre o valor inteiro (objeto, lista, texto, número) tirando CPF. */
function semCpf(valor: unknown, marcar: () => void): unknown | typeof REMOVER {
  if (typeof valor === "string") {
    // O valor INTEIRO é um CPF (só dígitos e a pontuação de costume): o campo sai.
    if (/^[\d.\-\s/]+$/.test(valor) && isValidCpf(valor)) {
      marcar();
      return REMOVER;
    }
    const { texto, achou } = semCpfNoTexto(valor);
    if (achou) marcar();
    return texto;
  }
  if (typeof valor === "number") {
    // CPF gravado como número perde os zeros da frente. Abaixo de nove dígitos
    // não é CPF de ninguém vivo — e é onde moram idade, ano e quantidade.
    if (Number.isInteger(valor) && valor >= 1e8 && valor < 1e11 && isValidCpf(String(valor).padStart(11, "0"))) {
      marcar();
      return REMOVER;
    }
    return valor;
  }
  if (Array.isArray(valor)) {
    return valor.map((item) => semCpf(item, marcar)).filter((item) => item !== REMOVER);
  }
  if (valor && typeof valor === "object") {
    const limpo: Record<string, unknown> = {};
    for (const [chave, interno] of Object.entries(valor)) {
      if (chaveDeCpf(chave)) {
        if (interno !== null && interno !== undefined && interno !== "") marcar();
        continue;
      }
      const tratado = semCpf(interno, marcar);
      if (tratado !== REMOVER) limpo[chave] = tratado;
    }
    return limpo;
  }
  return valor;
}

function comoTexto(valor: unknown, definicao: Definicao | undefined): string {
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  if (typeof valor === "string") return definicao?.opcoes.get(valor) ?? valor;
  if (Array.isArray(valor) && valor.every((v) => typeof v === "string")) {
    return valor.map((v) => definicao?.opcoes.get(v as string) ?? (v as string)).join(", ");
  }
  return typeof valor === "number" ? String(valor) : JSON.stringify(valor);
}

export interface CamposDoTitular {
  /** `custom_fields` sem CPF em lugar nenhum — é o que vai para o arquivo de dados. */
  semCpf: Record<string, unknown>;
  /** Para o PDF: rótulo + valor, na ordem em que estavam guardados. */
  campos: CampoLegivel[];
  /** Havia CPF em algum campo (pela chave ou pelo valor). O relatório diz que existe; não mostra. */
  cpfInformado: boolean;
}

export function camposDoTitular(
  customFields: Record<string, unknown>,
  definicoes: Map<string, Definicao>,
): CamposDoTitular {
  let cpfInformado = false;
  const marcar = () => {
    cpfInformado = true;
  };
  const limpo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(customFields)) {
    if (chaveDeCpf(chave)) {
      if (valor !== null && valor !== undefined && valor !== "") marcar();
      continue;
    }
    if (campoDeTelefone(chave, definicoes.get(chave))) {
      limpo[chave] = valor;
      continue;
    }
    const tratado = semCpf(valor, marcar);
    if (tratado !== REMOVER) limpo[chave] = tratado;
  }

  const campos: CampoLegivel[] = [];
  for (const [chave, valor] of Object.entries(limpo)) {
    if (valor === null || valor === undefined || valor === "") continue;
    if (Array.isArray(valor) && valor.length === 0) continue;
    const definicao = definicoes.get(chave);
    campos.push({
      rotulo: definicao?.label ?? ROTULOS_FIXOS[chave] ?? legivel(chave),
      valor: comoTexto(valor, definicao),
    });
  }
  return { semCpf: limpo, campos, cpfInformado };
}
