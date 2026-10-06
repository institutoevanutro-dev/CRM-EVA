/**
 * Interpola variáveis de template com o nome do contato (Onda 5).
 * Suporta {{nome}} e {{primeiro_nome}}. Variável desconhecida mantém o literal
 * `{{x}}`.
 *
 * O nome chega JÁ RESOLVIDO por quem chama — `nomeDoContato`
 * (`lib/contacts/rotulo-do-contato.ts`): `name`, depois o `display_name` do
 * perfil, nunca um identificador técnico (telefone, `@lid`).
 *
 * Sem nome, dois modos:
 *  - `manter` (padrão, caixa de entrada): o literal fica, e quem vai enviar vê
 *    e corrige;
 *  - `remover` (follow-up, que sai sem ninguém olhar): a variável sai do texto e
 *    só a pontuação em volta dela se ajusta — "Ei, {{primeiro_nome}}, tá por
 *    aí?" vira "Ei, tá por aí?".
 */
export interface TemplateContact {
  /** O nome já resolvido (ver o cabeçalho). */
  name?: string | null;
}

export interface InterpolacaoOpcoes {
  semValor?: "manter" | "remover";
}

const VARIAVEL = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;
const VARIAVEL_DO_NOME = /\{\{\s*(nome|primeiro_nome)\s*\}\}/i;

export function interpolateTemplate(
  body: string,
  contact: TemplateContact,
  opcoes: InterpolacaoOpcoes = {},
): string {
  const full = (contact.name ?? "").trim();
  const first = full.split(/\s+/)[0] ?? "";
  const preenchido = body.replace(VARIAVEL, (literal, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === "nome") return full !== "" ? full : literal;
    if (key === "primeiro_nome") return first !== "" ? first : literal;
    return literal; // desconhecida: mantém
  });
  if (opcoes.semValor !== "remover" || full !== "") return preenchido;
  let texto = preenchido;
  for (let m = VARIAVEL_DO_NOME.exec(texto); m; m = VARIAVEL_DO_NOME.exec(texto)) {
    texto = semAVariavel(texto, m.index, m[0].length);
  }
  return texto;
}

/**
 * Tira a variável e ajusta só o que está colado nela:
 *  - no começo do texto: sai também a pontuação seguinte (`,.!?;:`) e os
 *    espaços, e a primeira letra vira maiúscula;
 *  - vírgula dos dois lados: fica uma; só antes: sai; só depois: fica;
 *  - sem vírgula: sai a variável e o espaço antes dela.
 */
function semAVariavel(texto: string, inicio: number, tamanho: number): string {
  const antes = texto.slice(0, inicio).replace(/\s+$/, "");
  const depois = texto.slice(inicio + tamanho);
  if (antes === "") {
    const resto = depois.replace(/^[\s,.!?;:]+/, "");
    return resto.charAt(0).toUpperCase() + resto.slice(1);
  }
  const depoisSemEspaco = depois.replace(/^\s+/, "");
  const virgulaAntes = antes.endsWith(",");
  const virgulaDepois = depoisSemEspaco.startsWith(",");
  if (virgulaAntes && virgulaDepois) return antes + depoisSemEspaco.slice(1);
  if (virgulaAntes) return antes.slice(0, -1) + depois;
  if (virgulaDepois) return antes + depoisSemEspaco;
  return antes + depois;
}
