import { describe, expect, it } from "vitest";

import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  palavrasDoNome,
  parDeContatos,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { fichaVivaDe } from "@/lib/contacts/dispensar-par";

/**
 * O repetido pelo NOME (porte do #3640). O nome sugere, não prova: a régua é de
 * raridade (palavra comum não conta) e de nome inteiro contido — este com as
 * regras do fork: o nome contido precisa de 2 palavras, 6 letras e uma palavra
 * rara. Cada caso diz, no comentário, a sabotagem que o deixa vermelho. Todos
 * os nomes são fictícios.
 */
function contato(id: string, campos: Partial<ContatoParaDeduplicar> = {}): ContatoParaDeduplicar {
  return {
    id,
    name: null,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    is_merged_into: null,
    is_anonymized: false,
    source_metadata: null,
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    do_instagram: false,
    ...campos,
  };
}

const idsDosPares = (pares: ReturnType<typeof encontrarParecidosPorNome>) =>
  pares.map((p) => p.contatos.map((c) => c.id).sort());

describe("nome parecido: palavras raras", () => {
  it("1. dois nomes que dividem 2 palavras raras formam 1 par", () => {
    // Sabotagem: exigir 3 palavras em comum (ou nenhuma régua) deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia" }),
      contato("b", { name: "Santos Odontologia Clínica Avançada" }),
    ]);
    expect(pares).toHaveLength(1);
    expect(pares[0]!.motivos).toEqual(["nome_parecido"]);
    expect(idsDosPares(pares)).toEqual([["a", "b"]]);
  });

  it("2. a palavra comum, presente em 5 fichas, não forma par", () => {
    // Sabotagem: a régua "qualquer palavra em comum" deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Alfa Odontologia" }),
      contato("b", { name: "Beta Odontologia" }),
      contato("c", { name: "Gama Odontologia" }),
      contato("d", { name: "Delta Odontologia" }),
      contato("e", { name: "Épsilon Odontologia" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("nome parecido: nome inteiro contido", () => {
  it("3. 'Guarnieri Materiais' dentro de 'Comercial - Guarnieri Materiais' forma 1 par", () => {
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Guarnieri Materiais" }),
      contato("b", { name: "Comercial - Guarnieri Materiais" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("4. nome contido curto ('Ana' em 'Ana Paula Doces') não forma par", () => {
    // Sabotagem: tirar o mínimo de palavras e de letras do critério (b) faz 'ana' casar.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Ana" }),
      contato("b", { name: "Ana Paula Doces" }),
    ]);
    expect(pares).toEqual([]);
  });

  it("8. caixa e acento não impedem o par: 'JOSÉ CONFEITARIA DOCE' e 'jose confeitaria doce lar'", () => {
    // Sabotagem: não normalizar acento e caixa deixa 'josé' e 'jose' diferentes.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "JOSÉ CONFEITARIA DOCE" }),
      contato("b", { name: "jose confeitaria doce lar" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("fork: 'Ana Paula' com 4 fichas 'Ana Paula X' não forma par (nome composto comum)", () => {
    // Sabotagem: tirar a exigência de palavra rara no critério (b) faz 'Ana Paula'
    // casar com as 4 fichas.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Ana Paula" }),
      contato("b", { name: "Ana Paula Ferreira" }),
      contato("c", { name: "Ana Paula Moreira" }),
      contato("d", { name: "Ana Paula Siqueira" }),
      contato("e", { name: "Ana Paula Teixeira" }),
    ]);
    expect(pares).toEqual([]);
  });

  it("fork: 'Fernanda' dentro de 'Fernanda Brandão', só as duas fichas, não forma par", () => {
    // Sabotagem: tirar a regra das 2 palavras faz o nome de uma palavra só casar.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Fernanda" }),
      contato("b", { name: "Fernanda Brandão" }),
    ]);
    expect(pares).toEqual([]);
  });

  it("fork: 'Fernanda B Tavares' e 'Mariana B Tavares' não formam par pela inicial", () => {
    // Sabotagem: contar palavra de 1 letra faz 'b' virar a segunda palavra rara.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Fernanda B Tavares" }),
      contato("b", { name: "Mariana B. Tavares" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("nome parecido: o nome que a varredura lê", () => {
  it("5. ficha com name nulo e o nome só em display_name entra no par", () => {
    // Sabotagem: ler só `name` faz a ficha A ficar sem palavras.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: null, display_name: "Confeitaria Doce Lar" }),
      contato("b", { name: "Confeitaria Doce Lar Centro" }),
    ]);
    expect(pares).toHaveLength(1);
  });

  it("fork: identificador técnico não forma par ('Contato 543134@lid', só dígitos)", () => {
    // Sabotagem: comparar o `name`/`display_name` cru, sem `nomeDoContato`, faz os
    // dois rótulos técnicos iguais formarem par.
    const pares = encontrarParecidosPorNome([
      contato("a", { display_name: "Contato 543134@lid" }),
      contato("b", { display_name: "Contato 543134@lid" }),
      contato("c", { display_name: "5531999990000" }),
      contato("d", { display_name: "5531999990000" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("nome parecido: não se mistura com o grupo forte", () => {
  it("6. mesmo telefone (com e sem o nono dígito) e nomes parecidos: não é par de nome, e o forte segue", () => {
    // Sabotagem: não excluir quem já é forte faria este par aparecer como nome também.
    const a = contato("a", { name: "Clínica Santos Odontologia", phone_number: "+553198966398" });
    const b = contato("b", { name: "Santos Odontologia Clínica", phone_number: "+5531998966398" });

    expect(encontrarParecidosPorNome([a, b])).toEqual([]);
    const fortes = encontrarContatosDuplicados([a, b]);
    expect(fortes).toHaveLength(1);
    expect(fortes[0]!.motivos).toEqual(["telefone"]);
  });

  it("fork: o par Instagram × WhatsApp de mesmo nome é grupo forte e não volta como nome_parecido", () => {
    const insta = contato("insta", { do_instagram: true, display_name: "Josefa Prado Lins" });
    const zap = contato("zap", { name: "Josefa Prado Lins", phone_number: "+5531998966398" });

    expect(encontrarContatosDuplicados([insta, zap])[0]!.motivos).toEqual(["mesmo_nome_instagram_whatsapp"]);
    expect(encontrarParecidosPorNome([insta, zap])).toEqual([]);
  });
});

describe("nome parecido: dispensa", () => {
  it("7. par dispensado não aparece, nem com a ordem dos ids invertida", () => {
    // Sabotagem: ignorar `dispensados`, ou uma chave de par que dependa da ordem.
    const a = contato("aaa", { name: "Clínica Santos Odontologia" });
    const b = contato("bbb", { name: "Santos Odontologia Clínica" });
    expect(parDeContatos("bbb", "aaa")).toBe(parDeContatos("aaa", "bbb"));

    const dispensados = new Set([parDeContatos("bbb", "aaa")]);
    expect(encontrarParecidosPorNome([a, b], { dispensados })).toEqual([]);
    expect(encontrarParecidosPorNome([a, b])).toHaveLength(1);
  });
});

describe("nome parecido: quem não é sugerido", () => {
  it("9. anonimizada ou mesclada não entra", () => {
    // Sabotagem: não filtrar `elegivelParaMesclagem` faz a lápide e a anonimizada entrarem.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Clínica Santos Odontologia" }),
      contato("b", { name: "Santos Odontologia Clínica", is_anonymized: true }),
      contato("c", { name: "Santos Odontologia Clínica Avançada", is_merged_into: "a" }),
    ]);
    expect(pares).toEqual([]);
  });
});

describe("palavrasDoNome", () => {
  it("tira acento, pontuação, palavra de ligação e inicial, sem repetir", () => {
    expect(palavrasDoNome("Clínica - Santos DA Santos, Dr.")).toEqual(["clinica", "santos"]);
    expect(palavrasDoNome("Fernanda B. Tavares")).toEqual(["fernanda", "tavares"]);
  });
});

describe("fichaVivaDe (a dispensa acompanha a fusão)", () => {
  it("10. segue a cadeia de fusões até a ficha viva", () => {
    // A mesclada em B, B mesclada em C: quem era A vira C.
    const mapa = new Map<string, string | null>([
      ["A", "B"],
      ["B", "C"],
      ["C", null],
    ]);
    expect(fichaVivaDe("A", mapa)).toBe("C");
  });

  it("10b. ciclo não gira para sempre: devolve um id visto", () => {
    const mapa = new Map<string, string | null>([
      ["X", "Y"],
      ["Y", "X"],
    ]);
    expect(["X", "Y"]).toContain(fichaVivaDe("X", mapa));
  });

  it("10c. mais de 5 saltos para na 5ª ficha, sem laço", () => {
    const mapa = new Map<string, string | null>();
    for (let i = 1; i <= 8; i++) mapa.set(String(i), String(i + 1));
    expect(fichaVivaDe("1", mapa)).toBe("6");
  });
});

describe("nome parecido: nome igual", () => {
  it("11. nome de uma palavra, igual, não forma par; igual com 2 palavras e uma rara forma", () => {
    // Sabotagem (curtos): aceitar nome de uma palavra faz 'joao' ou 'guarnieri' formar par.
    expect(encontrarParecidosPorNome([contato("a", { name: "João" }), contato("b", { name: "joao" })])).toEqual([]);
    expect(
      encontrarParecidosPorNome([contato("a", { name: "Guarnieri" }), contato("b", { name: "GUARNIERI" })]),
    ).toEqual([]);

    // Só 'guarnieri' é rara ('maria' está em 5 fichas): o critério (a) não pega o
    // par, e só o (b) o encontra. Sabotagem: tirar o critério (b) deixa vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Maria Guarnieri" }),
      contato("b", { name: "MARIA GUARNIERI" }),
      contato("c", { name: "Maria Alfa" }),
      contato("d", { name: "Maria Beta" }),
      contato("e", { name: "Maria Gama" }),
    ]);
    expect(idsDosPares(pares)).toEqual([["a", "b"]]);
  });
});

describe("nome parecido: só o critério do nome contido", () => {
  it("12. 'Comercial Guarnieri' dentro de 'Loja Comercial Guarnieri' forma par mesmo com 'comercial' comum", () => {
    // Só UMA palavra rara em comum ('guarnieri'): o critério (a) não pega o par, e
    // 'comercial' está em 6 fichas. Sabotagem: tirar o critério (b) — ou a borda de
    // espaço que o delimita — deixa este caso vermelho.
    const pares = encontrarParecidosPorNome([
      contato("a", { name: "Comercial Guarnieri" }),
      contato("b", { name: "Loja Comercial Guarnieri" }),
      contato("c", { name: "Comercial Alfa" }),
      contato("d", { name: "Comercial Beta" }),
      contato("e", { name: "Comercial Gama" }),
      contato("f", { name: "Comercial Delta" }),
    ]);
    expect(idsDosPares(pares)).toEqual([["a", "b"]]);
  });
});
