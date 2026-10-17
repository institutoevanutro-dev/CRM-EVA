import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A PASTA DE SITES EXTRAS DO CADDY, presa por máquina.
 *
 * O Caddy do CRM também serve sites que não são do produto (ex.: o site da
 * Conta, o login único), gravados em `sites/*.caddy` ao lado do compose. São
 * quatro peças, e qualquer uma faltando quebra calado:
 *
 * 1. O `import` no Caddyfile, DEPOIS do bloco de opções globais (ele tem de ser
 *    o primeiro bloco do arquivo: um site importado antes dele faria o Caddy
 *    recusar o arquivo inteiro) e ANTES do site do CRM, longe do fim: um bloco
 *    que alguém acrescentou à mão no fim do Caddyfile não colide com ele.
 * 2. A montagem da pasta no serviço `caddy`: sem ela o import não acha nada.
 * 3. O `.gitignore`: o que mora na pasta é da VPS, e o repositório é público.
 * 4. O `mkdir -p` no install.sh e no update.sh ANTES do `up -d`, para a pasta
 *    existir com o dono da instalação quando o compose a montar.
 *
 * Pasta vazia, site válido e site quebrado foram medidos com `caddy validate`
 * na imagem do compose: válido, válido e recusado (e o Caddy não sobe com um
 * arquivo quebrado na pasta).
 */
const RAIZ = process.cwd();
const ler = (arquivo: string) => fs.readFileSync(path.join(RAIZ, arquivo), "utf8");

const IMPORT = "import /etc/caddy/sites/*.caddy";
const MONTAGEM = "- ./sites:/etc/caddy/sites:ro";
const MKDIR = 'mkdir -p "$PROJECT_DIR/sites"';

/** Primeira linha de CÓDIGO que começa com `inicio`: comentário cita os mesmos textos. */
function linhaDeCodigo(texto: string, inicio: string): number {
  return texto.split("\n").findIndex((l) => !l.trim().startsWith("#") && l.trim().startsWith(inicio));
}

/** As linhas de um serviço do compose, até o próximo serviço ou a próxima seção. */
function blocoDoServico(compose: string, servico: string): string[] {
  const linhas = compose.split("\n");
  const inicio = linhas.indexOf(`  ${servico}:`);
  if (inicio === -1) return [];
  const resto = linhas.slice(inicio + 1);
  const fim = resto.findIndex((l) => /^ {0,2}\S/.test(l));
  return fim === -1 ? resto : resto.slice(0, fim);
}

describe("a pasta de sites extras do Caddy", () => {
  it("o Caddyfile importa a pasta uma vez, entre o bloco global e o site do CRM", () => {
    const linhas = ler("Caddyfile").split("\n").map((l) => l.trim());
    const imports = linhas.flatMap((l, i) => (l === IMPORT ? [i] : []));
    expect(imports, `esperava exatamente uma linha "${IMPORT}"`).toHaveLength(1);

    const abreGlobal = linhas.indexOf("{");
    const fechaGlobal = linhas.indexOf("}", abreGlobal);
    const siteDoCrm = linhas.indexOf("{$DOMAIN} {");
    expect(abreGlobal, "o Caddyfile perdeu o bloco de opções globais").toBeGreaterThanOrEqual(0);
    expect(fechaGlobal, "o bloco de opções globais não fecha").toBeGreaterThan(abreGlobal);
    expect(siteDoCrm, "o Caddyfile perdeu o site {$DOMAIN}").toBeGreaterThan(fechaGlobal);

    const [linhaDoImport = -1] = imports;
    expect(linhaDoImport, "o import tem de vir depois do bloco global").toBeGreaterThan(fechaGlobal);
    expect(linhaDoImport, "o import tem de vir antes do site do CRM").toBeLessThan(siteDoCrm);
  });

  it("o serviço caddy monta a pasta, só leitura", () => {
    const bloco = blocoDoServico(ler("docker-compose.prod.yml"), "caddy").map((l) => l.trim());
    expect(bloco.length, "não achei o serviço caddy no docker-compose.prod.yml").toBeGreaterThan(0);
    expect(bloco).toContain(MONTAGEM);
  });

  it("a pasta fica fora do git", () => {
    expect(ler(".gitignore").split("\n").map((l) => l.trim())).toContain("/sites/");
  });

  it.each(["hostgator-setup-kit/install.sh", "hostgator-setup-kit/update.sh"])(
    "%s cria a pasta antes do primeiro up -d",
    (script) => {
      const texto = ler(script);
      const mkdir = linhaDeCodigo(texto, MKDIR);
      const up = linhaDeCodigo(texto, "dc up -d");
      expect(mkdir, `${script} não cria a pasta sites`).toBeGreaterThanOrEqual(0);
      expect(up, `${script} sem "dc up -d"`).toBeGreaterThanOrEqual(0);
      expect(mkdir, "a pasta tem de existir antes do up -d que sobe o caddy").toBeLessThan(up);
    },
  );
});
