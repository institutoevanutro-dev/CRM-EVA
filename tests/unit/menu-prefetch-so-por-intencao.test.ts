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
 * A régua é dura de propósito: TODO `<Link>` do menu tem de receber as props do
 * hook, ou declarar `prefetch={false}` à mão. As props do hook são o
 * espalhamento da chamada de um nome que o PRÓPRIO arquivo liga a
 * `usePrefetchPorIntencao()` (na lateral, `const intencao = …`).
 * `{...outraCoisa(href)}` tem a mesma forma e pode trazer qualquer `prefetch`,
 * então não conta. Ela lê a árvore do TSX, a mesma técnica de
 * `i18n-espanhol-cobre-a-tela`: o que se prende é a FORMA do JSX, não o
 * resultado de um render.
 *
 * E vale a ÚLTIMA palavra sobre o prefetch, porque no JSX a prop que vem depois
 * ganha: `{...intencao(href)} prefetch` (ou `prefetch={true}`, ou qualquer outro
 * espalhamento depois do hook, chamada ou não) religa o prefetch e reprova. A
 * versão anterior lia o texto e só procurava o espalhamento, então essas
 * passavam; e, cortando a tag no primeiro `>`, não via nada depois de um `=>`.
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

const PREFETCH_DESLIGADO = /prefetch\s*=\s*\{false\}/;

/**
 * Cada `<Link>` do texto e se ele termina com o prefetch desligado. Os
 * atributos vêm na ordem do código, que é a ordem em que o JSX os aplica.
 */
function links(texto: string): Array<{ tag: string; desligado: boolean }> {
  const fonteTsx = ts.createSourceFile("menu.tsx", texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Os nomes ligados ao hook no arquivo: as props dele (`prefetch: false` +
  // `onPointerEnter`/`onFocus`) só vêm da chamada de um destes.
  const doHook = new Set<string>();
  // Nomes declarados de QUALQUER outro jeito (outro hook, parâmetro, função):
  // o nome repetido em outro escopo não pode passar como se fosse o hook.
  const outros = new Set<string>();
  const ligar = (no: ts.Node): void => {
    if (
      ts.isVariableDeclaration(no) &&
      ts.isIdentifier(no.name) &&
      no.initializer !== undefined &&
      ts.isCallExpression(no.initializer) &&
      no.initializer.expression.getText(fonteTsx) === "usePrefetchPorIntencao"
    ) {
      doHook.add(no.name.text);
    } else if (
      (ts.isVariableDeclaration(no) || ts.isParameter(no) || ts.isBindingElement(no) || ts.isFunctionDeclaration(no)) &&
      no.name !== undefined &&
      ts.isIdentifier(no.name)
    ) {
      outros.add(no.name.text);
    }
    ts.forEachChild(no, ligar);
  };
  ligar(fonteTsx);
  const achados: Array<{ tag: string; desligado: boolean }> = [];
  const visitar = (no: ts.Node): void => {
    if ((ts.isJsxOpeningElement(no) || ts.isJsxSelfClosingElement(no)) && no.tagName.getText(fonteTsx) === "Link") {
      let desligado = false;
      for (const atributo of no.attributes.properties) {
        if (ts.isJsxSpreadAttribute(atributo)) {
          const e = atributo.expression;
          desligado =
            ts.isCallExpression(e) &&
            ts.isIdentifier(e.expression) &&
            doHook.has(e.expression.text) &&
            !outros.has(e.expression.text);
        } else if (atributo.name.getText(fonteTsx) === "prefetch") {
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
        `Todo <Link> do menu precisa de \`{...intencao(href)}\`, com \`const intencao = usePrefetchPorIntencao()\` ` +
          `no arquivo (ou \`prefetch={false}\`), e nenhum espalhamento depois dele. ` +
          `Sem isso o Next prefetcha a tela inteira sozinho e disputa o servidor com o clique:\n` +
          semPrefetch.join("\n---\n"),
      ).toEqual([]);
    });
  }

  it("a régua reprova o prefetch religado e o espalhamento que não é o do hook, inclusive depois de um `=>`", () => {
    // Como na lateral: o nome do espalhamento vem ligado ao hook no próprio arquivo.
    const comHook = (tag: string) => `const intencao = usePrefetchPorIntencao();\n${tag}`;
    const religados = [
      `<Link href={d.href} {...intencao(d.href)} prefetch>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} prefetch={true}>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} onClick={(e) => ir(e)} prefetch={undefined}>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} {...resto}>x</Link>`,
      // A mesma forma do hook, de outra função: pode trazer qualquer `prefetch`.
      `<Link href={d.href} {...outraCoisa(d.href)}>x</Link>`,
      `<Link href={d.href} {...intencao(d.href)} {...outraCoisa(d.href)}>x</Link>`,
    ];
    for (const tag of religados) expect(links(comHook(tag)).map((l) => l.desligado), tag).toEqual([false]);
    // Antes do espalhamento, quem decide é o hook, que vem depois.
    const sobrescrito = `<Link href={d.href} prefetch={true} {...intencao(d.href)}>x</Link>`;
    expect(links(comHook(sobrescrito)).map((l) => l.desligado)).toEqual([true]);
    // O nome sozinho não basta: `intencao` ligado a outra função não desliga nada,
    // nem no mesmo arquivo do hook (o nome é conferido por arquivo, não por escopo,
    // então repetir o nome reprova os dois e obriga a trocar um deles).
    expect(links(`const intencao = outroHook();\n${sobrescrito}`).map((l) => l.desligado)).toEqual([false]);
    const doisComponentes =
      `function A(){ const intencao = usePrefetchPorIntencao(); return <Link href="/a" {...intencao("/a")}>a</Link>; }\n` +
      `function B(){ const intencao = useOutroHook(); return <Link href="/b" {...intencao("/b")}>b</Link>; }`;
    expect(links(doisComponentes).map((l) => l.desligado)).toEqual([false, false]);
    const parametro = comHook(`<>{itens.map((intencao) => <Link href="/b" {...intencao(intencao.href)}>b</Link>)}</>`);
    expect(links(parametro).map((l) => l.desligado)).toEqual([false]);
  });

  it("o hook que desliga o prefetch automático existe e é o do módulo de navegação", () => {
    const texto = fonte("hooks/navigation/prefetchPorIntencao.ts");
    expect(texto).toContain("export function usePrefetchPorIntencao");
    expect(texto).toContain("prefetch: false as const");
    expect(texto).toContain("router.prefetch(href)");
  });
});
