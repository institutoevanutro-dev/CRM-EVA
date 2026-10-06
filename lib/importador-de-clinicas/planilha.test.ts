// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  ABA_ATENDENTES, ABA_CLINICAS, ABA_PERGUNTAS, abasDoModelo, COLUNAS, fusoValido, lerHorarios, lerPlanilha,
} from "./planilha";
import { gerarXlsx, lerXlsx, type Abas } from "./xlsx";

const cabecalho = (aba: string) => COLUNAS[aba]!.map((c) => c.titulo);
const CAB_CLINICAS = cabecalho(ABA_CLINICAS);
const CAB_PERGUNTAS = cabecalho(ABA_PERGUNTAS);
const CAB_ATENDENTES = cabecalho(ABA_ATENDENTES);

function clinica(codigo: string, troca: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    "Código": codigo, "Nome da clínica": `Clínica ${codigo}`, "Razão social": "", "CNPJ": "",
    "Telefone": "(27) 99999-8888", "E-mail": "", "Endereço": "Rua A, 1, Vitória - ES",
    "Horários": "seg-sex 08:00-18:00; sab 08:00-12:00", "Convênios": "Uniodonto; Amil Dental",
    "Especialidades": "", "Nome da assistente": "", "Fuso horário": "",
  };
  return CAB_CLINICAS.map((c) => troca[c] ?? base[c]!);
}

function abas(clinicas: string[][], perguntas: string[][] = [], atendentes: string[][] = []): Abas {
  return new Map([
    [ABA_CLINICAS, [CAB_CLINICAS, ...clinicas]],
    [ABA_PERGUNTAS, [CAB_PERGUNTAS, ...perguntas]],
    [ABA_ATENDENTES, [CAB_ATENDENTES, ...atendentes]],
  ]);
}

describe("lerHorarios", () => {
  it.each([
    ["seg-sex 08:00-18:00; sab 08:00-12:00", "Segunda a Sexta: 08:00 às 18:00; Sábado: 08:00 às 12:00"],
    ["Segunda-feira a sexta-feira 8h às 18h", "Segunda a Sexta: 08:00 às 18:00"],
    ["seg, qua 08:00-12:00 e 14:00-18:30\ndom fechado", "Segunda, Quarta: 08:00 às 12:00 e 14:00 às 18:30; Domingo: fechado"],
    ["sábado: 8h30-12h", "Sábado: 08:30 às 12:00"],
  ])("lê %j", (bruto, esperado) => {
    expect(lerHorarios(bruto)).toBe(esperado);
  });

  it.each(["0.3333333333", "comercial", "seg 18:00-08:00", "sex-seg 08:00-12:00", "seg 25:00-26:00", ""])(
    "recusa %j",
    (bruto) => {
      expect(lerHorarios(bruto)).toBeNull();
    },
  );
});

describe("fusoValido", () => {
  it("aceita IANA e recusa o resto", () => {
    expect(fusoValido("America/Sao_Paulo")).toBe(true);
    expect(fusoValido("Brasília")).toBe(false);
  });
});

describe("lerPlanilha", () => {
  it("planilha boa: normaliza código, slug, telefone, horários, convênios e papel", () => {
    const r = lerPlanilha(
      abas(
        [clinica("ilha-001 ", { "CNPJ": "12.345.678/0001-90", "Fuso horário": "America/Bahia" })],
        [["ILHA-001", "Convênios", "Atendemos Uniodonto.", "aceita convênio?; vocês atendem Uniodonto?\nquais planos?"]],
        [["ILHA-001", "Maria", "Maria@Example.com", "Supervisor"]],
      ),
    );
    expect(r.fatal).toBeNull();
    expect(r.erros).toEqual([]);
    expect(r.clinicas).toHaveLength(1);
    const c = r.clinicas[0]!;
    expect(c).toMatchObject({
      linha: 2, codigo: "ILHA-001", slug: "ilha-001", nome: "Clínica ilha-001",
      razaoSocial: "Clínica ilha-001", cnpj: "12345678000190", fuso: "America/Bahia",
      horarios: "Segunda a Sexta: 08:00 às 18:00; Sábado: 08:00 às 12:00",
      convenios: ["Uniodonto", "Amil Dental"], especialidades: null, assistente: null,
    });
    expect(c.telefone.startsWith("+5527")).toBe(true);
    expect(r.perguntas).toEqual([
      { linha: 2, codigo: "ILHA-001", titulo: "Convênios", resposta: "Atendemos Uniodonto.",
        perguntas: ["aceita convênio?", "vocês atendem Uniodonto?", "quais planos?"] },
    ]);
    expect(r.atendentes).toEqual([{ linha: 2, codigo: "ILHA-001", nome: "Maria", email: "maria@example.com", papel: "manager" }]);
  });

  it("célula numérica (planilha passada pelo Excel): telefone serve, horário vira erro legível", () => {
    const r = lerPlanilha(abas([clinica("ILHA-002", { "Telefone": "27999998888", "Horários": "0.3333333333" })]));
    expect(r.clinicas).toEqual([]);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0]).toMatchObject({ aba: "Clínicas", linha: 2, codigo: "ILHA-002" });
    expect(r.erros[0]!.mensagem).toContain("ilegível");
  });

  it("código repetido com outra caixa é erro, e atribuído à clínica", () => {
    const r = lerPlanilha(abas([clinica("ILHA-003"), clinica("ilha-003")]));
    expect(r.erros.map((e) => [e.linha, e.codigo])).toEqual([[3, "ILHA-003"]]);
    expect(r.erros[0]!.mensagem).toContain("repetido");
  });

  it("cada conferência aponta aba e linha", () => {
    const r = lerPlanilha(
      abas(
        [clinica("ILHA-004", { "Telefone": "123", "E-mail": "não-é-email", "Fuso horário": "Brasília" })],
        [
          ["ILHA-999", "X", "Y", "uma pergunta"],
          ["ILHA-004", "", "Resposta", "uma pergunta"],
        ],
        [
          ["ILHA-004", "Ana", "ana@", "gerente"],
          ["ILHA-404", "Bia", "bia@example.com", "atendente"],
        ],
      ),
    );
    const resumo = r.erros.map((e) => `${e.aba}:${e.linha}:${e.codigo ?? "-"}`);
    expect(resumo).toEqual([
      "Clínicas:2:ILHA-004", "Clínicas:2:ILHA-004", "Clínicas:2:ILHA-004",
      "Perguntas frequentes:2:-", "Perguntas frequentes:3:ILHA-004",
      "Atendentes:2:ILHA-004", "Atendentes:2:ILHA-004", "Atendentes:3:-",
    ]);
  });

  it("título repetido na mesma clínica e atendente repetido são erro", () => {
    const r = lerPlanilha(
      abas(
        [clinica("ILHA-005")],
        [["ILHA-005", "Preço", "R$ 100", "quanto custa?"], ["ILHA-005", "Preço", "R$ 120", "qual o valor?"]],
        [["ILHA-005", "Ana", "ana@example.com", "atendente"], ["ILHA-005", "Ana", "ANA@example.com", "atendente"]],
      ),
    );
    expect(r.erros.map((e) => `${e.aba}:${e.linha}`)).toEqual(["Perguntas frequentes:3", "Atendentes:3"]);
  });

  it("aba ou coluna obrigatória faltando é fatal", () => {
    expect(lerPlanilha(new Map([[ABA_CLINICAS, [CAB_CLINICAS]]])).fatal).toContain("Perguntas frequentes");
    const semTelefone = abas([]);
    semTelefone.set(ABA_CLINICAS, [CAB_CLINICAS.filter((c) => c !== "Telefone")]);
    expect(lerPlanilha(semTelefone).fatal).toContain("Telefone");
  });

  it("o modelo gerado é lido sem erro, e as linhas de exemplo são ignoradas com aviso", () => {
    const r = lerPlanilha(lerXlsx(gerarXlsx(abasDoModelo())));
    expect(r.fatal).toBeNull();
    expect(r.erros).toEqual([]);
    expect(r.clinicas).toEqual([]);
    expect(r.avisos).toHaveLength(3);
  });

  it("o exemplo do modelo, com outro código, é uma clínica válida", () => {
    const modelo = abasDoModelo();
    const lidas: Abas = new Map(
      modelo.map((a) => [a.nome, a.linhas.map((l, i) => (i === 0 ? l : [l[0]!.replace("EXEMPLO", "TESTE"), ...l.slice(1)]))]),
    );
    const r = lerPlanilha(lidas);
    expect(r.erros).toEqual([]);
    expect(r.clinicas).toHaveLength(1);
    expect(r.perguntas).toHaveLength(1);
    expect(r.atendentes).toHaveLength(1);
  });
});
