/**
 * O LOGO DE QUEM HOSPEDA NUNCA É DESENHADO CRU CONTRA UM FUNDO ESCURO.
 *
 * ═══ O DEFEITO ═══
 *
 * O produto aceita UM logo só — `platform_branding.logo_url` /
 * `organizations.settings.branding` —, e não há segunda arte para o tema
 * escuro. A arte que o operador sobe é, quase sempre, pensada para fundo
 * claro. O `--color-surface` do tema escuro é `#1d1c17`: um logo azul-marinho
 * ou preto ali não tem contraste nenhum e simplesmente some, sem erro, sem
 * aviso e sem nada na tela dizendo que sumiu.
 *
 * O conserto é um chip claro POR BAIXO do logo, ligado ao tema. Ele aparece em
 * três superfícies, e as três precisam concordar — consertar uma só devolve o
 * defeito nas outras duas:
 *
 *   1. a barra lateral do app          (`components/shell/Sidebar.tsx`)
 *   2. a tela de entrada               (`app/(public)/layout.tsx`)
 *   3. a PRÉVIA da tela de marca       (`components/branding/CampoDeLogo.tsx`)
 *
 * A terceira é a que mais engana: se a prévia mostrar o logo cru onde o app
 * real desenha um chip, ela deixa de ser prévia — o operador aprova na tela de
 * marca uma coisa e recebe outra no produto.
 *
 * ═══ ⚠️ ESTE TESTE É UMA CERCA, NÃO UMA PROVA ═══
 *
 * Ele garante que o `<img>` do logo continue ENVOLVIDO pelo chip, que é o modo
 * pelo qual o conserto voltaria atrás em silêncio: desembrulhar a imagem não
 * gera conflito de merge, não muda tipo nenhum, e nada na tela grita. O que ele
 * NÃO faz é medir contraste num navegador — isso é Playwright com
 * `getComputedStyle`, e está anotado como pendência.
 *
 * As duas primeiras superfícies usam a variante `dark:` do Tailwind, que neste
 * repo é `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *))`
 * (app/globals.css) — ou seja, segue o tema DO APP, não o do sistema
 * operacional. A terceira não pode usar `dark:`: ela desenha as duas aparências
 * lado a lado no MESMO tema real, simulando o fundo por `style`, então lá a
 * condição é o rótulo da caixa.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const leia = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");

/** Tira comentário para que uma menção em prosa não satisfaça a cerca. */
const semComentario = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

/**
 * O `<img>` é o PRIMEIRO filho do elemento que carrega a classe do chip.
 *
 * ⚠️ Proximidade não é contenção, e a primeira versão desta cerca caiu nisso:
 * ela procurava `<img` nos 800 caracteres seguintes à classe, e a sabotagem
 * que a derrubaria — transformar o chip em IRMÃO auto-fechado do `<img>`,
 * `<div className="…chip…" /><div><img …/></div>` — passou VERDE. O logo
 * voltava a ser desenhado cru e a guarda não via.
 *
 * A régua certa tem dois passos: a tag do chip NÃO pode se auto-fechar (`/>`),
 * e a primeira tag depois dela tem de ser o `<img>`.
 */
function imgDoLogoEstaDentroDoChip(fonte: string, classeDoChip: RegExp): boolean {
  const i = fonte.search(classeDoChip);
  if (i < 0) return false;
  const fimDaTag = fonte.indexOf(">", i);
  if (fimDaTag < 0) return false;
  if (fonte[fimDaTag - 1] === "/") return false; // chip auto-fechado: não embrulha nada
  const proximaTag = fonte.slice(fimDaTag + 1).match(/<\s*([A-Za-z][A-Za-z0-9]*)/);
  return proximaTag?.[1] === "img";
}

describe("o logo do operador não some no tema escuro", () => {
  it("a BARRA LATERAL é verde nos dois temas e desenha o logo SEM chip", () => {
    // Mudou em 07/10/2026 (spec 2026-10-07-cores-e-menu, decisão do dono): o menu passou a
    // ser verde-escuro nos DOIS temas, então o chip claro deixaria de proteger contraste e
    // viraria a moldura branca que o dono pediu para tirar. Logo de arte escura precisa de
    // versão clara/transparente em Configurações › Marca.
    const fonte = semComentario(leia("components/shell/Sidebar.tsx"));
    expect(fonte, "a barra lateral voltou a pôr chip claro no logo").not.toMatch(/dark:bg-white/);
    expect(fonte, "a barra lateral deixou de ser verde nos dois temas").toMatch(/\bbg-sidebar\b/);
  });

  it("a TELA DE ENTRADA desenha o logo sobre o mesmo chip", () => {
    // O login também respeita `data-theme` — o `ThemeProvider` embrulha a raiz
    // inteira (`app/layout.tsx`), a fachada inclusa.
    const fonte = semComentario(leia("app/(public)/layout.tsx"));

    expect(fonte, "sumiu o chip `dark:bg-white` da tela de entrada").toMatch(/dark:bg-white/);
    expect(
      imgDoLogoEstaDentroDoChip(fonte, /dark:bg-white/),
      "o `<img>` do logo saiu de dentro do chip `dark:bg-white`",
    ).toBe(true);
  });

  it("a PRÉVIA da tela de marca mostra o chip na caixa da aparência escura", () => {
    // Aqui a condição não pode ser `dark:` — ver o cabeçalho. Ela é o rótulo da
    // caixa, e o chip é incondicional dentro dela.
    const fonte = semComentario(leia("components/branding/CampoDeLogo.tsx"));

    expect(
      fonte,
      "a prévia da aparência escura voltou a mostrar o logo cru — ela deixa de prever o que o app desenha",
    ).toMatch(/Apar.ncia escura["')\s]*\s*\?\s*["'`][^"'`]*bg-white/);
  });

  it("CONTROLE: as três superfícies continuam sendo as três que desenham o logo do operador", () => {
    // Se uma quarta tela passar a desenhar `<img src={logo}>`, esta cerca fica
    // com escopo velho sem avisar — que é exatamente o modo de falha que o
    // `barra-lateral-nao-perde-o-sticky` registra. O número aqui é MEDIDO, não
    // chutado: em 2026-09-11, na prévia do merge do PR #659, `logoUrl`/`logo`
    // chegava a um `<img>` em exatamente três arquivos.
    const SUPERFICIES = [
      "components/shell/Sidebar.tsx",
      "app/(public)/layout.tsx",
      "components/branding/CampoDeLogo.tsx",
    ];
    for (const arquivo of SUPERFICIES) {
      expect(semComentario(leia(arquivo)), `${arquivo} deixou de desenhar o logo`).toMatch(/<img\b/);
    }
  });
});
