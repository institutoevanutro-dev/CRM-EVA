/**
 * A cor do menu lateral escolhida pela organização (`settings.branding.menu_hex`).
 *
 * O menu NÃO segue a marca sozinho: com o campo em branco o verde de fábrica do
 * `app/globals.css` fica, qualquer que seja a cor da marca. Quando a organização
 * escolhe uma cor, este módulo a transforma nos dois tokens que `css.ts` emite
 * (`--color-sidebar-bg` e `--color-sidebar-tint`), sempre em `#rrggbb`, porque
 * a allowlist de `css.ts` não aceita `color-mix` no valor.
 *
 * A frente do menu é clara (`--color-sidebar-fg` e `--color-sidebar-muted`), então
 * a cor escolhida só pode ESCURECER: se o texto não passar de 4,5:1, o fundo desce
 * de luz até passar. `menuFoiEscurecido` é o que a tela usa para avisar.
 */

import { PISOS, razaoDeContraste } from "./contraste";
import { compor, hexParaOklch, normalizarHex, oklchParaHex } from "./rampa";

/**
 * A frente do menu (`--color-sidebar-fg` do `app/globals.css`). Os testes conferem
 * que os dois literais daqui são os mesmos do CSS.
 */
export const FRENTE_DO_MENU = "#e9e2c8";

/** O texto secundário do menu (`--color-sidebar-muted`). */
export const FRENTE_SECUNDARIA_DO_MENU = "#b9b39c";

/** O menu de fábrica, no claro: a referência de luz do botão "Usar a cor da marca". */
const MENU_DE_FABRICA = "#1d352c";

/**
 * A cor que o degradê do menu mistura na base. De fábrica é `--color-success`
 * (#5a8a5f no claro, #82a077 no escuro).
 */
const BASE_DO_DEGRADE_DE_FABRICA = { claro: "#5a8a5f", escuro: "#82a077" } as const;

/**
 * Quanto de preto o escuro põe sobre o claro. É a relação que o `globals.css`
 * desenhou à mão: #1d352c com 60% de preto dá #0c1512, contra o #0b1612 real.
 */
const PRETO_DO_ESCURO = 0.6;

/** A luz e o croma (no máximo) da referência, com o matiz da cor dada. */
function naLuzDe(referencia: string, cor: string): { L: number; C: number; h: number } {
  const ref = hexParaOklch(referencia);
  const c = hexParaOklch(cor);
  return { L: ref.L, C: Math.min(ref.C, c.C), h: c.h };
}

function textoPassa(fundo: string): boolean {
  return (
    Math.min(
      razaoDeContraste(fundo, FRENTE_DO_MENU),
      razaoDeContraste(fundo, FRENTE_SECUNDARIA_DO_MENU),
    ) >= PISOS.texto
  );
}

/**
 * A sugestão do botão "Usar a cor da marca": a luz do menu de fábrica, o matiz da
 * marca e o croma menor entre os dois. Com a marca verde de fábrica sai o próprio
 * `#1d352c`; uma marca cinza dá um cinza quase preto, sem saturação emprestada.
 */
export function menuDaCorDaMarca(semente: string): string {
  return oklchParaHex(naLuzDe(MENU_DE_FABRICA, semente));
}

/**
 * O fundo do menu por tema. No claro, a cor escolhida, escurecida só se o texto
 * principal ou o secundário ficar abaixo de 4,5:1. No escuro, o claro com 60% de
 * preto por cima.
 */
export function fundoDoMenu(menu: string, tema: "claro" | "escuro"): string {
  let fundo = normalizarHex(menu);
  const inicial = hexParaOklch(fundo);
  const { C, h } = inicial;
  let { L } = inicial;
  while (!textoPassa(fundo)) {
    L -= 0.02;
    fundo = oklchParaHex({ L, C, h });
  }
  return tema === "claro" ? fundo : compor("#000000", PRETO_DO_ESCURO, fundo);
}

/** `true` quando a cor escolhida precisou escurecer para o texto do menu passar. */
export function menuFoiEscurecido(menu: string): boolean {
  return fundoDoMenu(menu, "claro") !== normalizarHex(menu);
}

/**
 * A base do degradê (`--color-sidebar-tint`): a luz e o croma máximo do verde de
 * fábrica, com o matiz da cor do menu. Um menu de outro matiz não fica com verde
 * no pé, e um menu cinza ganha base cinza.
 */
export function baseDoDegradeDoMenu(menu: string, tema: "claro" | "escuro"): string {
  return oklchParaHex(naLuzDe(BASE_DO_DEGRADE_DE_FABRICA[tema], menu));
}
