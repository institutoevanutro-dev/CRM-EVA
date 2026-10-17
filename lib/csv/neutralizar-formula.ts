/**
 * A aspa simples que faz a planilha mostrar texto como texto, e não executar
 * como fórmula, na frente de todo trecho de célula que começa com `=`, `+`, `-`,
 * `@`, TAB ou CR (porte do upstream #3001).
 *
 * "Todo trecho", e não só o começo da célula, porque quem lê o CSV nem sempre
 * divide como o RFC 4180: o Excel em português divide por `;`, e ali as aspas
 * de um campo não protegem nada; um leitor sem aspas divide em `,`. Todo trecho
 * que começa depois de `;`, `,`, LF ou CR pode virar célula.
 *
 * Número puro passa intacto (telefone `+55…`, `-2` dentro de um JSON): a
 * planilha o lê como número, sem função, e a aspa estragaria o dado. O número
 * pode vir seguido do separador que o encerra (`-2,` no meio de `[1,-2,3]`).
 */
const GATILHO = /^[=+\-@\t\r]/;
const NUMERO = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?[\]}]*[;,\n\r]?$/;

export function neutralizarFormula(texto: string): string {
  return texto
    .split(/(?<=[;,\n\r])/)
    .map((trecho) => (GATILHO.test(trecho) && !NUMERO.test(trecho) ? `'${trecho}` : trecho))
    .join("");
}
