import { describe, expect, it } from "vitest";

import { CPF_OMITIDO, camposDoTitular, definicoesDoFunil, legivel, semCpfNoTexto } from "@/lib/lgpd/campos-personalizados";

/**
 * OS CAMPOS PERSONALIZADOS NO RELATÓRIO DO TITULAR: nome legível, e CPF nunca.
 *
 * O relatório do Art. 18 II lia `contacts.custom_fields` e jogava fora — e é
 * ali que este fork guarda o endereço (`custom_fields.endereco`). Ao passar a
 * entregá-los, o risco novo é o CPF: quem digita o CPF num campo livre o põe
 * fora da coluna cifrada, e o relatório o imprimiria em claro. A política do
 * fork para CPF é dizer que existe e nunca mostrar o número.
 */

// CPF de teste com dígitos verificadores válidos (o mesmo dos outros testes de LGPD).
const CPF = "52998224725";
const CPF_PONTUADO = "529.982.247-25";

const FUNIL = {
  fields: [
    { key: "convenio", label: "Convênio", type: "select", options: [{ value: "unimed", label: "Unimed Vitória" }] },
    { key: "como_conheceu", label: "Como conheceu a clínica?", type: "text" },
    { key: "aceita_lembrete", label: "Aceita lembrete", type: "boolean" },
    { key: "interesses", label: "Interesses", type: "multiselect", options: [{ value: "botox", label: "Botox" }, { value: "peel", label: "Peeling" }] },
  ],
};

describe("rótulo: o titular lê o nome do campo, não a chave", () => {
  it("usa o rótulo do funil padrão, o da opção escolhida, e 'Endereço' para o campo fixo da ficha", () => {
    const r = camposDoTitular(
      {
        endereco: "Rua das Flores, 100 — Vitória/ES",
        convenio: "unimed",
        como_conheceu: "Indicação da Ana",
        aceita_lembrete: true,
        interesses: ["botox", "peel"],
      },
      definicoesDoFunil(FUNIL),
    );
    expect(r.campos).toEqual([
      { rotulo: "Endereço", valor: "Rua das Flores, 100 — Vitória/ES" },
      { rotulo: "Convênio", valor: "Unimed Vitória" },
      { rotulo: "Como conheceu a clínica?", valor: "Indicação da Ana" },
      { rotulo: "Aceita lembrete", valor: "Sim" },
      { rotulo: "Interesses", valor: "Botox, Peeling" },
    ]);
    expect(r.cpfInformado).toBe(false);
  });

  it("chave sem definição vira texto legível, e campo vazio não vira linha", () => {
    expect(legivel("cidade_natal")).toBe("Cidade natal");
    const r = camposDoTitular({ cidade_natal: "Colatina", observacao: "", nulo: null, lista: [] }, new Map());
    expect(r.campos).toEqual([{ rotulo: "Cidade natal", valor: "Colatina" }]);
  });

  it("funil sem campos, com lixo ou ausente não quebra o relatório", () => {
    for (const settings of [null, undefined, {}, { fields: "x" }, { fields: [null, 3, { label: "sem chave" }] }]) {
      expect(definicoesDoFunil(settings).size).toBe(0);
    }
  });
});

describe("CPF em campo personalizado nunca sai em claro", () => {
  it.each([
    ["pela chave `cpf`", { cpf: CPF }],
    ["pela chave em maiúsculas", { CPF: CPF_PONTUADO }],
    ["pela chave composta", { cpf_do_responsavel: CPF }],
    ["pelo VALOR, numa chave que não diz CPF", { documento: CPF_PONTUADO }],
    ["gravado como número", { documento: Number(CPF) }],
    ["no meio de um texto", { observacao: `Paciente informou CPF ${CPF_PONTUADO} na recepção` }],
    ["sem pontuação, grudado em rótulo", { observacao: `cpf:${CPF}` }],
    ["dentro de objeto aninhado", { responsavel: { nome: "Ana", cpf: CPF } }],
    ["dentro de lista", { documentos: [CPF_PONTUADO, "RG 1234567"] }],
  ])("%s", (_como, customFields) => {
    const r = camposDoTitular(customFields as Record<string, unknown>, new Map());
    const tudo = JSON.stringify(r);
    expect(tudo).not.toContain(CPF);
    expect(tudo).not.toContain(CPF_PONTUADO);
    expect(tudo).not.toContain("529.982");
    expect(r.cpfInformado).toBe(true);
  });

  it("o campo de CPF some inteiro — não vira uma segunda linha de CPF no relatório", () => {
    const r = camposDoTitular({ cpf: CPF, endereco: "Rua A, 1" }, new Map());
    expect(r.campos).toEqual([{ rotulo: "Endereço", valor: "Rua A, 1" }]);
    expect(r.semCpf).toEqual({ endereco: "Rua A, 1" });
  });

  it("o resto do texto em volta do CPF fica", () => {
    const r = camposDoTitular({ observacao: `Titular do plano, CPF ${CPF_PONTUADO}, dependente: filho` }, new Map());
    expect(r.campos[0]?.valor).toBe(`Titular do plano, CPF ${CPF_OMITIDO}, dependente: filho`);
  });

  it("CONTROLE: o que não é CPF fica como está — telefone, CEP, ano, protocolo", () => {
    const campos = {
      telefone_recado: "(27) 99999-0000",
      // `27999990000` FECHA os dígitos verificadores de um CPF (um celular em
      // cada cem fecha). Num campo que se diz telefone, é telefone.
      celular: "27999990000",
      contato_de_emergencia: "27999990000",
      cep: "29000-000",
      ano: 2020,
      idade: 35,
      protocolo: "12345678901", // onze dígitos, verificador inválido
    };
    const r = camposDoTitular(
      campos,
      definicoesDoFunil({ fields: [{ key: "contato_de_emergencia", label: "Contato de emergência", type: "phone" }] }),
    );
    expect(r.cpfInformado).toBe(false);
    expect(r.semCpf).toEqual(campos);
    expect(semCpfNoTexto("ligar para 27988887777 depois das 14h")).toEqual({
      texto: "ligar para 27988887777 depois das 14h",
      achou: false,
    });
  });

  it("onze dígitos que fecham como CPF, num campo que NÃO se diz telefone, saem — errar para este lado custa menos", () => {
    const r = camposDoTitular({ codigo: "27999990000" }, new Map());
    expect(r.semCpf).toEqual({});
    expect(r.cpfInformado).toBe(true);
  });

  it("CPF vazio numa chave de CPF não acusa que existe CPF", () => {
    expect(camposDoTitular({ cpf: "" }, new Map()).cpfInformado).toBe(false);
    expect(camposDoTitular({ cpf: null }, new Map()).cpfInformado).toBe(false);
  });
});
