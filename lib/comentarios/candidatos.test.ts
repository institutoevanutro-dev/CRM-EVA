import { describe, expect, it } from "vitest";
import { candidatosDoHistorico } from "./candidatos";
import { ehObviamenteSeguro } from "./seguranca";

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

/**
 * O TESTE QUE TERIA PEGO C-1 — a ida e volta, não só a ida.
 *
 * Os outros casos deste arquivo perguntam "a lista oferece a palavra certa?".
 * Nenhum fechava o laço: pegar o que a tela oferece, aprovar TUDO (é o que o
 * dono faz limpando a fila) e reconferir a trava. Com `ehTokenDeGatilho`
 * casando palavra inteira, "valores", "doses", "dores", "horarios",
 * "especialistas", "nutrologos" e "medicamentos" eram oferecidos — e aprovados
 * tornavam SEGURO o comentário de onde tinham saído.
 *
 * Por isso o corpus é de comentários de assunto sensível em FLEXÃO: é a forma
 * que a tela realmente mostrava.
 */
describe("ida e volta: aprovar o que a tela oferece não pode liberar assunto sensível", () => {
  const sensiveis = [
    "me passa os valores",
    "quais os valores doutor",
    "quais as doses",
    "tenho dores fortes",
    "quais os horarios",
    "voce indica especialistas",
    "tem nutrologos ai",
    "quais medicamentos",
    // O corpus acima só tinha plural REGULAR, e por isso ficou verde enquanto
    // "promocoes", "medicacoes", "reacoes" e "dosagens" ainda eram oferecidos:
    // o viés foi da língua de quem escreveu o corpus, não da régua. Plural de
    // -ão e de -em entra aqui para o próximo resíduo dessa classe aparecer
    // sozinho, e com frase que alguém escreveria mesmo.
    "amei, voces tem promocoes",
    "quais medicacoes voce indica",
    "tive reacoes fortes",
    "quais as dosagens",
  ];

  it.each(sensiveis)(
    '"%s" continua precisando de humano com TODAS as palavras oferecidas aprovadas',
    (texto) => {
      const oferecidas = new Set(candidatosDoHistorico([texto], new Set()).map((c) => c.palavra));
      expect(ehObviamenteSeguro(texto, oferecidas).seguro).toBe(false);
    },
  );

  it("o corpus inteiro junto também não vira seguro", () => {
    const todas = new Set(candidatosDoHistorico(sensiveis, new Set()).map((c) => c.palavra));
    for (const texto of sensiveis) {
      expect(ehObviamenteSeguro(texto, todas).seguro, texto).toBe(false);
    }
  });

  // CONTROLE POSITIVO: sem ele, o teste acima ficaria verde se a lista
  // parasse de oferecer qualquer coisa — que é o conserto errado.
  it("CONTROLE: elogio real continua sendo oferecido E liberando o comentário", () => {
    const elogio = "conteudo fantastico e didatico";
    const oferecidas = new Set(candidatosDoHistorico([elogio], new Set()).map((c) => c.palavra));
    expect([...oferecidas].sort()).toEqual(["didatico", "fantastico"]);
    expect(ehObviamenteSeguro(elogio, oferecidas)).toEqual({ seguro: true });
  });
});
