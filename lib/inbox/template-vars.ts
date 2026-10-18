/**
 * Interpola variáveis de template com os dados do contato (Onda 5).
 *
 * A lista é FECHADA (`VARIAVEIS_DO_TEMPLATE`): nome, primeiro nome, telefone e
 * e-mail. Nada de travessia de propriedade: CPF, data de nascimento,
 * observações, campos personalizados e dados do negócio (o título é texto
 * livre da equipe e pode carregar anotação interna) NÃO são variáveis, mesmo que
 * quem chama passe a linha inteira do banco. `{{contact.name}}`,
 * `{{contact.phone_number}}` e `{{contact.email}}` são sinônimos, para o texto
 * escrito no vocabulário das automações valer aqui também.
 *
 * O nome é resolvido AQUI, por `nomeDoContato` (`lib/contacts/rotulo-do-contato.ts`):
 * `name`, depois o `display_name` do perfil, nunca um identificador técnico
 * (telefone, `@lid`). Quem chama passa o contato bruto — a regra fica num
 * lugar só para a caixa de entrada, o atalho e o worker.
 *
 * Sem valor ou desconhecida, dois modos:
 *  - `manter` (padrão, caixa de entrada): o literal fica, e quem vai enviar vê
 *    e corrige;
 *  - `remover` (follow-up, que sai sem ninguém olhar): TODA `{{…}}` que sobrou
 *    sai do texto (a sem valor e a que não existe, como `{{nomee}}`) e só a
 *    pontuação em volta dela se ajusta — "Ei, {{primeiro_nome}}, tá por aí?"
 *    vira "Ei, tá por aí?". Se não sobra nada além de pontuação e espaço,
 *    devolve `""`: quem chama não envia (o passo é pulado).
 */
import { nomeDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";

export type TemplateContact = Pick<ContatoNomeavel, "name" | "display_name"> & {
  phone_number?: string | null;
  email?: string | null;
};

export interface InterpolacaoOpcoes {
  semValor?: "manter" | "remover";
}

/** As variáveis que existem, na ordem em que a tela as mostra. */
export const VARIAVEIS_DO_TEMPLATE = ["primeiro_nome", "nome", "telefone", "email"] as const;

type Variavel = (typeof VARIAVEIS_DO_TEMPLATE)[number];

const SINONIMOS: Record<string, Variavel> = {
  "contact.name": "nome",
  "contact.phone_number": "telefone",
  "contact.email": "email",
};

const VARIAVEL = /\{\{\s*([a-zA-Z_.]+)\s*\}\}/g;
/** Qualquer `{{…}}`, inclusive a que não é variável (`{{primeiro nome}}`, `{{1}}`). */
const QUALQUER_VARIAVEL = /\{\{[^{}]*\}\}/;

function variavelDe(bruto: string): Variavel | null {
  const chave = bruto.trim().toLowerCase();
  if ((VARIAVEIS_DO_TEMPLATE as readonly string[]).includes(chave)) return chave as Variavel;
  return Object.hasOwn(SINONIMOS, chave) ? SINONIMOS[chave]! : null;
}

/**
 * As `{{…}}` do texto que não são variáveis (erro de digitação, variável de
 * outra tela). `extras` são as que quem chama resolve por conta própria, como
 * `volta` e `voltas` do laço do follow-up.
 */
export function variaveisDesconhecidas(texto: string, extras: readonly string[] = []): string[] {
  return [...texto.matchAll(new RegExp(QUALQUER_VARIAVEL, "g"))]
    .map((m) => m[0])
    .filter((literal) => {
      const dentro = literal.slice(2, -2);
      return variavelDe(dentro) === null && !extras.includes(dentro.trim().toLowerCase());
    });
}

/**
 * Motivo FIXO que acompanha o botão quando a RESPOSTA é barrada pelo curinga de
 * nome literal (porte do upstream #2844, issue #2744). A trava
 * de envio e a faixa visível leem daqui: quem vê o motivo vê a razão exata.
 */
export const MOTIVO_CURINGA_LITERAL =
  "Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.";

/**
 * O motivo pelo qual a RESPOSTA não pode sair, ou `null` quando pode. O gate é
 * sobre o literal que SOBREVIVE: contato com nome de gente (`name` ou
 * `display_name`, pela mesma regra de `nomeDoContato`) resolve `{{nome}}` e não
 * é barrado; chave desconhecida (`{{codigo}}`) e telefone/e-mail vazios também
 * não contam, porque não são nome.
 */
export function motivoDoCuringaLiteral(body: string, contact: TemplateContact): string | null {
  if (nomeDoContato(contact)) return null;
  const sobrouNome = [...body.matchAll(VARIAVEL)].some((m) => {
    const variavel = variavelDe(m[1]!);
    return variavel === "nome" || variavel === "primeiro_nome";
  });
  return sobrouNome ? MOTIVO_CURINGA_LITERAL : null;
}

/** O que uma resposta rápida guarda além do texto (portado do original, DeskcommCRM PR #2704). */
export interface RespostaRapida {
  id?: string;
  body: string;
  /** Itens da Biblioteca de mídia, na ordem. `undefined`/`null`/`[]` = só texto. */
  media_item_ids?: readonly string[] | null;
}

/**
 * O que a escolha da resposta rápida entrega ao compositor: o corpo interpolado
 * (a legenda da PRIMEIRA imagem quando há imagem) e os itens da biblioteca, numa
 * lista NOVA (o compositor mexe na fila; a do cache do React Query não muda).
 */
export function payloadDeUso(
  template: RespostaRapida,
  contact: TemplateContact,
): { texto: string; midias: string[] } {
  return { texto: interpolateTemplate(template.body, contact), midias: [...(template.media_item_ids ?? [])] };
}

const texto = (valor: string | null | undefined) => (typeof valor === "string" ? valor.trim() : "");

export function interpolateTemplate(
  body: string,
  contact: TemplateContact,
  opcoes: InterpolacaoOpcoes = {},
): string {
  const full = nomeDoContato(contact) ?? "";
  const valores: Record<Variavel, string> = {
    nome: full,
    primeiro_nome: full.split(/\s+/)[0] ?? "",
    telefone: texto(contact.phone_number),
    email: texto(contact.email),
  };
  const preenchido = body.replace(VARIAVEL, (literal, rawKey: string) => {
    const variavel = variavelDe(rawKey);
    // Desconhecida ou sem valor: mantém; em `remover`, sai logo abaixo.
    return variavel !== null && valores[variavel] !== "" ? valores[variavel] : literal;
  });
  if (opcoes.semValor !== "remover") return preenchido;
  let saida = preenchido;
  for (let m = QUALQUER_VARIAVEL.exec(saida); m; m = QUALQUER_VARIAVEL.exec(saida)) {
    saida = semAVariavel(saida, m.index, m[0].length);
  }
  return /[^\s\p{P}]/u.test(saida) ? saida : "";
}

/**
 * Tira a variável e ajusta só o que está colado nela:
 *  - no começo do texto ou de uma linha: sai também a pontuação seguinte
 *    (`,.!?;:`) e os espaços, e a primeira letra vira maiúscula; a linha que
 *    fica vazia sai inteira;
 *  - entre parênteses: saem os parênteses;
 *  - vírgula dos dois lados: fica uma; só antes: sai; só depois: fica;
 *  - sem vírgula: sai a variável e o espaço antes dela.
 * Só espaço HORIZONTAL em volta é ajustado: a quebra de linha é do texto.
 * Exportada para a automação (`lib/automation/template.ts`) tirar o nome que
 * falta com a MESMA régua do follow-up.
 */
export function semAVariavel(texto: string, inicio: number, tamanho: number): string {
  const antes = texto.slice(0, inicio).replace(/[ \t]+$/, "");
  const depois = texto.slice(inicio + tamanho);
  if (antes === "") {
    const resto = depois.replace(/^[\s,.!?;:]+/, "");
    return resto.charAt(0).toUpperCase() + resto.slice(1);
  }
  if (antes.endsWith("\n")) {
    const resto = depois.replace(/^[ \t,.!?;:]+/, "");
    if (resto === "" || resto.startsWith("\n")) return antes.slice(0, -1) + resto;
    return antes + resto.charAt(0).toUpperCase() + resto.slice(1);
  }
  const depoisSemEspaco = depois.replace(/^[ \t]+/, "");
  if (antes.endsWith("(") && depoisSemEspaco.startsWith(")")) {
    return antes.slice(0, -1).replace(/[ \t]+$/, "") + depoisSemEspaco.slice(1);
  }
  const virgulaAntes = antes.endsWith(",");
  const virgulaDepois = depoisSemEspaco.startsWith(",");
  if (virgulaAntes && virgulaDepois) return antes + depoisSemEspaco.slice(1);
  if (virgulaAntes) return antes.slice(0, -1) + depois;
  if (virgulaDepois) return antes + depoisSemEspaco;
  return antes + depois;
}
