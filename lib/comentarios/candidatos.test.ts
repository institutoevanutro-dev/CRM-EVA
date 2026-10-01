import { describe, expect, it } from "vitest";
import { candidatosDoHistorico } from "./candidatos";

const nada = new Set<string>();

describe("candidatosDoHistorico", () => {
  it("oferece a palavra desconhecida, com quantos comentários ela apareceu", () => {
    const r = candidatosDoHistorico(["conteudo fantastico", "muito fantastico"], nada);
    expect(r).toEqual([{ palavra: "fantastico", vezes: 2 }]);
  });

  it("não oferece o que a trava já conhece", () => {
    expect(candidatosDoHistorico(["top demais", "muito bom"], nada)).toEqual([]);
  });

  // Global Constraint: palavra de gatilho NUNCA é oferecida.
  it("NUNCA oferece palavra de gatilho, nem preço nem especialidade", () => {
    const r = candidatosDoHistorico(
      ["quanto custa isso", "voce e nutrologo", "tomei mounjaro"],
      nada,
    );
    expect(r.map((c) => c.palavra)).not.toContain("custa");
    expect(r.map((c) => c.palavra)).not.toContain("nutrologo");
    expect(r.map((c) => c.palavra)).not.toContain("mounjaro");
  });

  it("não oferece o que já foi decidido, aprovado ou recusado", () => {
    expect(candidatosDoHistorico(["fantastico show"], new Set(["fantastico"]))).toEqual([]);
  });

  it("emoji e número não viram candidato: a trava já os aceita", () => {
    expect(candidatosDoHistorico(["🔥🔥 10"], nada)).toEqual([]);
  });

  // Review Focus 5: caixa e acento diferentes são UMA palavra.
  it("Conteúdo, CONTEUDO e conteudo contam como a mesma palavra", () => {
    const r = candidatosDoHistorico(["Didático demais", "DIDATICO", "didatico"], nada);
    expect(r).toEqual([{ palavra: "didatico", vezes: 3 }]);
  });

  it("conta COMENTÁRIOS, não ocorrências: repetir na mesma frase conta uma vez", () => {
    expect(candidatosDoHistorico(["didatico didatico didatico"], nada)).toEqual([
      { palavra: "didatico", vezes: 1 },
    ]);
  });

  it("marcação não vira candidato: ela sai da análise", () => {
    expect(candidatosDoHistorico(["@dr.andreluisc top"], nada)).toEqual([]);
  });

  it("ordena pelo que mais encolhe a fila, e alfabético no empate", () => {
    const r = candidatosDoHistorico(["aula didatica", "didatica", "zebra"], nada);
    expect(r.map((c) => c.palavra)).toEqual(["didatica", "zebra"]);
  });

  it("componente de gatilho multipalavra NUNCA é oferecido", () => {
    const r = candidatosDoHistorico(
      ["efeito colateral do tratamento", "voce e medico", "normal isso"],
      new Set(),
    ).map((c) => c.palavra);
    for (const p of ["efeito", "colateral", "voce", "medico", "normal"]) {
      expect(r, p).not.toContain(p);
    }
  });
});
