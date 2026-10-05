/**
 * Leitura e escrita MÍNIMAS de .xlsx, sobre o `fflate` que o CRM já tem.
 *
 * Um .xlsx é um zip de XML. Para três abas de texto basta: descompactar, ler o
 * `workbook.xml` (nome da aba → arquivo), as strings compartilhadas e as células.
 * Tudo vira TEXTO — número vira o texto do número —, e quem decide se o texto
 * serve é a conferência da planilha (`planilha.ts`), com aba e linha.
 *
 * ponytail: não lê data/hora formatada nem fórmula sem valor em cache; o modelo
 * marca as colunas como texto e a conferência recusa o que não for legível. Se
 * um arquivo real escapar disto, trocar o corpo de `lerXlsx` por
 * `read-excel-file` com versão exata (plano B da Task 1).
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/** Nome da aba → linhas. O índice `i` é a linha `i + 1` do Excel; linha ausente é `[]`. */
export type Abas = Map<string, string[][]>;

export class XlsxIlegivel extends Error {}

export interface AbaParaEscrever {
  nome: string;
  linhas: string[][];
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function desescapar(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTIDADES[e]!;
  });
}

function escapar(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function atributo(tag: string, nome: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${nome}="([^"]*)"`).exec(tag);
  return m ? desescapar(m[1]!) : undefined;
}

/** Junta os `<t>` (rich text vem em vários runs) e ignora a transliteração fonética. */
function textoDosRuns(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((m) => desescapar(m[1]!))
    .join("");
}

function indiceDaColuna(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function letraDaColuna(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function linhasDaAba(xml: string, compartilhadas: readonly string[]): string[][] {
  const linhas: string[][] = [];
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numero = Number(atributo(r[1]!, "r")) || linhas.length + 1;
    const celulas: string[] = [];
    let proxima = 0;
    for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = atributo(c[1]!, "r");
      const coluna = ref ? indiceDaColuna(ref) : proxima;
      proxima = coluna + 1;
      const corpo = c[2] ?? "";
      const tipo = atributo(c[1]!, "t");
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
      celulas[coluna] =
        tipo === "s"
          ? (compartilhadas[Number(v)] ?? "")
          : tipo === "inlineStr"
            ? textoDosRuns(corpo)
            : v === undefined
              ? ""
              : desescapar(v);
    }
    linhas[numero - 1] = Array.from(celulas, (x) => x ?? "");
  }
  return Array.from(linhas, (l) => l ?? []);
}

export function lerXlsx(bytes: Uint8Array): Abas {
  let arquivos: Record<string, Uint8Array>;
  try {
    // Só o XML da planilha: imagens e afins nem são descompactados.
    arquivos = unzipSync(bytes, { filter: (f) => /^xl\/.*\.(xml|rels)$/.test(f.name) });
  } catch {
    throw new XlsxIlegivel(
      "o arquivo não é um .xlsx — salve como \"Pasta de Trabalho do Excel (.xlsx)\" e tente de novo",
    );
  }
  const ler = (caminho: string): string | null => {
    const b = arquivos[caminho];
    return b ? strFromU8(b) : null;
  };
  const workbook = ler("xl/workbook.xml");
  if (!workbook) throw new XlsxIlegivel("o arquivo não tem planilha dentro (xl/workbook.xml ausente)");

  const alvos = new Map<string, string>();
  for (const m of (ler("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = atributo(m[1]!, "Id");
    const alvo = atributo(m[1]!, "Target");
    if (id && alvo) alvos.set(id, alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo}`);
  }
  const compartilhadas = [...(ler("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(
    (m) => textoDosRuns(m[1]!),
  );

  const abas: Abas = new Map();
  for (const m of workbook.matchAll(/<sheet\b([^>]*)>/g)) {
    const nome = atributo(m[1]!, "name");
    const id = atributo(m[1]!, "r:id");
    const caminho = id ? alvos.get(id) : undefined;
    const xml = caminho ? ler(caminho) : null;
    if (nome !== undefined && xml !== null) abas.set(nome.trim(), linhasDaAba(xml, compartilhadas));
  }
  return abas;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Estilo 1 = texto (`@`), para o Excel não converter telefone e horário; 2 = texto em negrito (cabeçalho). */
const ESTILOS =
  `<styleSheet ${NS}>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

function xmlDaAba(linhas: readonly string[][]): string {
  const largura = Math.max(1, ...linhas.map((l) => l.length));
  const corpo = linhas
    .map(
      (l, r) =>
        `<row r="${r + 1}">` +
        l
          .map(
            (valor, c) =>
              `<c r="${letraDaColuna(c)}${r + 1}" t="inlineStr" s="${r === 0 ? 2 : 1}"><is><t xml:space="preserve">${escapar(valor)}</t></is></c>`,
          )
          .join("") +
        `</row>`,
    )
    .join("");
  return `<worksheet ${NS}><cols><col min="1" max="${largura}" width="32" style="1" customWidth="1"/></cols><sheetData>${corpo}</sheetData></worksheet>`;
}

export function gerarXlsx(abas: readonly AbaParaEscrever[]): Uint8Array {
  const arquivos: Record<string, Uint8Array> = {};
  const gravar = (caminho: string, xml: string) => {
    arquivos[caminho] = strToU8(XML + xml);
  };
  gravar(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      abas
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      `</Types>`,
  );
  gravar(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  gravar(
    "xl/workbook.xml",
    `<workbook ${NS} xmlns:r="${REL}"><sheets>` +
      abas.map((a, i) => `<sheet name="${escapar(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
  );
  gravar(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      abas
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rId${abas.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
  );
  gravar("xl/styles.xml", ESTILOS);
  abas.forEach((a, i) => gravar(`xl/worksheets/sheet${i + 1}.xml`, xmlDaAba(a.linhas)));
  return zipSync(arquivos);
}
