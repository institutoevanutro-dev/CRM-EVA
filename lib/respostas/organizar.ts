/**
 * As respostas rápidas da clínica já vêm com o assunto no título —
 * "ATENDIMENTO · Pedir avaliação no Google". A tela usa esse prefixo para
 * agrupar, em vez de pedir um campo novo de categoria: o hábito da equipe já
 * é a organização.
 */
export interface GrupoDeRespostas<T> {
  assunto: string | null;
  itens: Array<{ item: T; nome: string }>;
}

const SEPARADOR = " · ";

export function separarAssunto(titulo: string): { assunto: string | null; nome: string } {
  const i = titulo.indexOf(SEPARADOR);
  if (i <= 0) return { assunto: null, nome: titulo };
  return { assunto: titulo.slice(0, i).trim(), nome: titulo.slice(i + SEPARADOR.length).trim() };
}

/** Agrupa pelo assunto, na ordem em que cada assunto aparece; sem assunto vai por último. */
export function agruparPorAssunto<T extends { title: string }>(itens: T[]): GrupoDeRespostas<T>[] {
  const grupos = new Map<string, GrupoDeRespostas<T>>();
  for (const item of itens) {
    const { assunto, nome } = separarAssunto(item.title);
    const chave = assunto?.toLocaleLowerCase("pt-BR") ?? "";
    const g = grupos.get(chave) ?? { assunto, itens: [] };
    g.itens.push({ item, nome });
    grupos.set(chave, g);
  }
  const semAssunto = grupos.get("");
  grupos.delete("");
  return [...grupos.values(), ...(semAssunto ? [semAssunto] : [])];
}

/** Busca sem acento e sem caixa, no título e no texto. */
export function casaComBusca(item: { title: string; body: string }, busca: string): boolean {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  const b = norm(busca.trim());
  return !b || norm(item.title).includes(b) || norm(item.body).includes(b);
}

/** "{{primeiro_nome}}" → "Primeiro nome": o nome da variável como a equipe lê. */
export function rotuloDaVariavel(nome: string): string {
  const v = nome.trim().replace(/_/g, " ");
  return v.charAt(0).toLocaleUpperCase("pt-BR") + v.slice(1);
}

/** Quebra o texto em pedaços de texto e de variável, para a tela desenhar a variável como etiqueta. */
export function pedacosDoTexto(texto: string): Array<{ tipo: "texto" | "variavel"; valor: string }> {
  const partes: Array<{ tipo: "texto" | "variavel"; valor: string }> = [];
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let ultimo = 0;
  for (const m of texto.matchAll(re)) {
    if (m.index! > ultimo) partes.push({ tipo: "texto", valor: texto.slice(ultimo, m.index) });
    partes.push({ tipo: "variavel", valor: rotuloDaVariavel(m[1]!) });
    ultimo = m.index! + m[0].length;
  }
  if (ultimo < texto.length) partes.push({ tipo: "texto", valor: texto.slice(ultimo) });
  return partes;
}
