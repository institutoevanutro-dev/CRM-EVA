// @vitest-environment node
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { gerarXlsx, lerXlsx, XlsxIlegivel } from "./xlsx";

/** Um .xlsx com a forma que o Excel grava: strings compartilhadas, rich text, número, alvo absoluto. */
function xlsxDoExcel(): Uint8Array {
  const x = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`);
  return zipSync({
    "[Content_Types].xml": x("<Types/>"),
    "xl/workbook.xml": x(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clínicas" sheetId="1" r:id="rId7"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": x(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/planilha.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": x(
      `<sst><si><t>Código</t></si><si><r><t>Sorriso </t></r><r><rPr><b/></rPr><t xml:space="preserve">&amp; Cia</t></r><rPh><t>fonetica</t></rPh></si><si><t/></si></sst>`,
    ),
    "xl/worksheets/planilha.xml": x(
      `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Telefone &lt;fixo&gt;</t></is></c></row>` +
        `<row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4" s="3"/><c r="C4"><v>27999998888</v></c><c r="D4" t="s"><v>2</v></c></row>` +
        `</sheetData></worksheet>`,
    ),
  });
}

describe("lerXlsx", () => {
  it("lê strings compartilhadas, rich text, inline, número e respeita a linha do Excel", () => {
    const abas = lerXlsx(xlsxDoExcel());
    const linhas = abas.get("Clínicas");
    expect(linhas).toBeDefined();
    expect(linhas![0]).toEqual(["Código", "", "Telefone <fixo>"]);
    expect(linhas![1]).toEqual([]);
    expect(linhas![2]).toEqual([]);
    expect(linhas![3]).toEqual(["Sorriso & Cia", "", "27999998888", ""]);
  });

  it("arquivo que não é zip vira XlsxIlegivel, nunca um erro cru", () => {
    expect(() => lerXlsx(strToU8("Código;Nome\nA;B"))).toThrow(XlsxIlegivel);
  });

  it("zip sem workbook vira XlsxIlegivel", () => {
    expect(() => lerXlsx(zipSync({ "a.txt": strToU8("oi") }))).toThrow(XlsxIlegivel);
  });
});

describe("gerarXlsx", () => {
  it("ida e volta preserva abas, ordem, acentos e caracteres especiais", () => {
    const abas = [
      { nome: "Clínicas", linhas: [["Código", "Nome"], ["A-1", "Sorriso & Cia <Centro> \"1\""]] },
      { nome: "Atendentes", linhas: [["E-mail"], ["  maria@example.com  "]] },
    ];
    const lidas = lerXlsx(gerarXlsx(abas));
    expect([...lidas.keys()]).toEqual(["Clínicas", "Atendentes"]);
    expect(lidas.get("Clínicas")).toEqual(abas[0]!.linhas);
    expect(lidas.get("Atendentes")).toEqual(abas[1]!.linhas);
  });
});
