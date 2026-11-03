/**
 * CERCA: NENHUM `<Link>` DO MENU VOLTA A PREFETCHAR A ÁRVORE INTEIRA
 * (porte do original #3613, issue #3170 lá).
 *
 * O conserto é uma linha por link (`prefetch={false}` + prefetch por intenção,
 * em `hooks/navigation/prefetchPorIntencao.ts`). O defeito, porém, volta
 * sozinho: basta alguém escrever um `<Link href={item.href}>` novo no menu, e o
 * `<Link>` do App Router prefetcha por padrão. Nesta base, cada item visível
 * custa um render RSC completo (`proxy.ts` + as consultas de
 * `app/app/layout.tsx`) a cada carga de tela de `/app`; no original a rajada
 * foi medida, e é ela que disputa o servidor com o clique.
 *
 * A régua é dura de propósito e não olha o nome da variável: TODO `<Link>` do
 * menu tem de receber as props do hook (o espalhamento `{...algo(href)}`), ou
 * declarar `prefetch={false}` à mão. Ela lê a árvore do TSX, a mesma técnica de
 * `i18n-espanhol-cobre-a-tela`: o que se prende é a FORMA do JSX, não o
 * resultado de um render.
 *
 * E vale a ÚLTIMA palavra sobre o prefetch, porque no JSX a prop que vem depois
 * ganha: `{...intencao(href)} prefetch` (ou `prefetch={true}`, ou outro
 * espalhamento depois do hook) religa o prefetch e reprova. A versão anterior
 * lia o texto e só procurava o espalhamento, então essas três passavam; e,
 * cortando a tag no primeiro `>`, não via nada depois de um `=>`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// A lateral e o rodapé de versão que ela desenha: aqui não há BarraInferior, e a
// gaveta do celular (`MobileSidebar`) reaproveita o `SidebarContent` da lateral.
const ARQUIVOS_DO_MENU = ["components/shell/Sidebar.tsx", "components/shell/VersionFooter.tsx"];

function fonte(relativo: string): string {
  return readFileSync(join(process.cwd(), relativo), "utf8");
}

/**
 * As props do hook viajam juntas: `prefetch: false` + `onPointerEnter`/`onFocus`.
 * O argumento aceita caminho literal (`"/app/inicio"`) e o `!` de
 * `item.itens[0]!.href`.
 */
const PEDE_POR_INTENCAO = /\{\.\.\.[A-Za-z_$][\w$]*\(\s*[\w.$[\]'"/!]+\s*\)\}/;
const PREFETCH_DESLIGADO = /prefetch\s*=\s*\{false\}/;

/**
 * Cada `<Link>` do texto e se ele termina com o prefetch desligado. Os
 * atributos vêm na ordem do código, que é a ordem em que o JSX os aplica.
 */
function links(texto: string): Array<{ tag: string; desligado: boolean }> {
  const fonteTsx = ts.createSourceFile("menu.tsx", texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const achados: Array<{ tag: string; desligado: boolean }> = [];
  const visitar = (no: ts.Node): void => {
    if ((ts.isJsxOpeningElement(no) || ts.isJsxSelfClosingElement(no)) && no.tagName.getText(fonteTsx) === "Link") {
      let desligado = false;
      for (const atributo of no.attributes.properties) {
        if (ts.isJsxSpreadAttribute(atributo)) desligado = PEDE_POR_INTENCAO.test(atributo.getText(fonteTsx));
        else if (atributo.name.getText(fonteTsx) === "prefetch") {
          desligado = PREFETCH_DESLIGADO.test(atributo.getText(fonteTsx));
        }
      }
      achados.push({ tag: no.getText(fonteTsx), desligado });
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonteTsx);
  return achados;
}

describe("o menu não prefetcha a árvore inteira (porte do original #3613)", () => {
  for (const arquivo of ARQUIVOS_DO_MENU) {
    it(`${arquivo}: todo <Link> declara prefetch por intenção`, () => {
      const todos = links(fonte(arquivo));
      expect(todos.length, `${arquivo} não tem <Link> nenhum — a cerca perdeu o alvo`).toBeGreaterThan(0);
      const semPrefetch = todos.filter((l) => !l.desligado).map((l) => l.tag);
      expect(
        semPrefetch,
        `Todo <Link> do menu precisa de \`{...intencao(href)}\` (ou \`prefetch={false}\`). ` +
          `Sem isso o Next prefetcha a tela inteira sozinho e disputa o servidor com o clique:\n` +
          semPrefetch.join("\n---\n"),
      ).toEqual([]);
    });
  }

  it("a régua reprova o prefetch religado depois do espalhamento, inclusive depois de um `=>`", () => {
    const religados = [
      `<Link href={d.href} {...intencao(d.href)} prefetch>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} prefetch={true}>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} onClick={(e) => ir(e)} prefetch={undefined}>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} {...resto}>x</Link>`,
    ];
    for (const tag of religados) expect(links(tag).map((l) => l.desligado), tag).toEqual([false]);
    // Antes do espalhamento, quem decide é o hook, que vem depois.
    const sobrescrito = `<Link href={d.href} prefetch={true} {...intencao(d.href)}>x</Link>`;
    expect(links(sobrescrito).map((l) => l.desligado)).toEqual([true]);
  });

  it("o hook que desliga o prefetch automático existe e é o do módulo de navegação", () => {
    const texto = fonte("hooks/navigation/prefetchPorIntencao.ts");
    expect(texto).toContain("export function usePrefetchPorIntencao");
    expect(texto).toContain("prefetch: false as const");
    expect(texto).toContain("router.prefetch(href)");
  });
});
