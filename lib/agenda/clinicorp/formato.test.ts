/**
 * O formato do webhook da Clinicorp sai SEM valor: o que importa aqui é que nome,
 * telefone, observação e e-mail do paciente não atravessam, nem como chave. Os
 * dados são fictícios e o formato do payload é inventado (o real é o que o
 * receptor vai medir).
 */
import { describe, expect, it } from "vitest";

import { descreverFormato, FORMATOS_GUARDADOS, lerCorpo, nomesDosCabecalhos, somarFormato } from "./formato";

const PACIENTE = {
  nome: "Paciente Ficticia Webhook",
  fone: "27900002222",
  email: "paciente@exemplo.test",
  nota: "observacao ficticia que nao pode vazar",
};

const payload = {
  event: "appointment_modified",
  data: {
    id: 7700001,
    date: "2030-03-12T13:00:00.000Z",
    AtomicDate: "20300312",
    fromTime: "10:00",
    toTime: "11:30",
    Canceled: "X",
    Patient: { Name: PACIENTE.nome, MobilePhone: PACIENTE.fone, Email: PACIENTE.email },
    Notes: PACIENTE.nota,
    valor: 12.5,
    ativo: true,
    vazio: "",
    nada: null,
    itens: [{ a: 1 }, { a: "texto livre", b: 2 }],
    // Mapa cuja chave é o próprio dado: a chave não pode sair.
    porTelefone: { [PACIENTE.fone]: 1, [PACIENTE.nome]: 2 },
  },
};

describe("descreverFormato", () => {
  const linhas = descreverFormato(payload);
  const tudo = JSON.stringify(linhas);

  it("nenhum valor do paciente sai, nem como chave", () => {
    for (const v of Object.values(PACIENTE)) expect(tudo).not.toContain(v);
    expect(tudo).not.toContain("7700001");
    expect(tudo).not.toContain("2030");
  });

  it("dá o caminho e a classe de cada campo", () => {
    expect(linhas).toEqual(
      expect.arrayContaining([
        "$: objeto",
        "$.event: evento:appointment_modified",
        "$.data.id: numero-inteiro",
        "$.data.date: texto-data-hora-utc",
        "$.data.AtomicDate: texto-digitos(8)",
        "$.data.fromTime: texto-hora",
        "$.data.Canceled: texto-uma-letra",
        "$.data.Patient.Name: texto",
        "$.data.Patient.MobilePhone: texto-digitos(11)",
        "$.data.Notes: texto",
        "$.data.valor: numero-decimal",
        "$.data.ativo: booleano",
        "$.data.vazio: texto-vazio",
        "$.data.nada: nulo",
        "$.data.itens: lista",
        "$.data.itens[].a: numero-inteiro|texto",
        "$.data.itens[].b: numero-inteiro",
        "$.data.porTelefone.<numero>: numero-inteiro",
        "$.data.porTelefone.<chave>: numero-inteiro",
      ]),
    );
  });

  it("em ordem de caminho: o pai antes dos filhos", () => {
    expect(descreverFormato({ b: { c: 1 }, a: 1 })).toEqual(["$: objeto", "$.a: numero-inteiro", "$.b: objeto", "$.b.c: numero-inteiro"]);
  });

  it("não se perde em JSON fundo nem gigante", () => {
    let fundo: unknown = "fim";
    for (let i = 0; i < 50; i++) fundo = { x: fundo };
    expect(descreverFormato(fundo).length).toBeLessThanOrEqual(10);
    const largo = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`c${i}`, i]));
    expect(descreverFormato(largo).length).toBeLessThanOrEqual(300);
  });
});

describe("lerCorpo", () => {
  it("lê JSON, formulário e vazio; texto que não é JSON não sai", () => {
    expect(lerCorpo('{"a":1}', "application/json")).toEqual({ a: 1 });
    expect(lerCorpo("a=1&b=x", "application/x-www-form-urlencoded")).toEqual({ a: "1", b: "x" });
    expect(lerCorpo("", null)).toBeNull();
    expect(JSON.stringify(descreverFormato(lerCorpo(PACIENTE.nota, "text/plain")))).not.toContain(PACIENTE.nota);
  });
});

describe("nomesDosCabecalhos", () => {
  it("só os nomes, nunca os valores", () => {
    const nomes = nomesDosCabecalhos(new Headers({ "X-Assinatura": "segredo-ficticio", "Content-Type": "application/json" }));
    expect(nomes).toEqual(["content-type", "x-assinatura"]);
    expect(JSON.stringify(nomes)).not.toContain("segredo-ficticio");
  });
});

describe("somarFormato", () => {
  const novo = { metodo: "POST", tipo_de_conteudo: "application/json", cabecalhos: [], linhas: ["$: objeto"] };

  it("o mesmo formato soma vezes e vai para o topo; o novo entra no topo", () => {
    const um = somarFormato([], novo, new Date("2030-01-01T00:00:00Z"));
    const outro = somarFormato(um, { ...novo, linhas: ["$: lista"] }, new Date("2030-01-02T00:00:00Z"));
    const deNovo = somarFormato(outro, novo, new Date("2030-01-03T00:00:00Z"));
    expect(deNovo).toHaveLength(2);
    expect(deNovo[0]).toMatchObject({ id: um[0]!.id, vezes: 2, primeira_vez: "2030-01-01T00:00:00.000Z", ultima_vez: "2030-01-03T00:00:00.000Z" });
  });

  it("guarda no máximo os mais recentes", () => {
    let lista = somarFormato("lixo", novo, new Date());
    for (let i = 0; i < 30; i++) lista = somarFormato(lista, { ...novo, linhas: [`$.c${i}: nulo`] }, new Date());
    expect(lista).toHaveLength(FORMATOS_GUARDADOS);
    expect(lista[0]!.linhas).toEqual(["$.c29: nulo"]);
  });
});
