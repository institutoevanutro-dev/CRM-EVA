import { describe, expect, it } from "vitest";

import { FRASES_PADRAO, abreConversa, frasesComoGuardadas, frasesDeGatilho } from "./gatilho-direct";

describe("abreConversa — quais gatilhos viram mensagem privada", () => {
  it("preço e agendamento abrem conversa: são intenção de compra", () => {
    expect(abreConversa("preço")).toBe(true);
    expect(abreConversa("agendamento")).toBe(true);
  });

  it("assunto clínico NUNCA abre conversa sozinho", () => {
    expect(abreConversa("medicação")).toBe(false);
    expect(abreConversa("sintoma")).toBe(false);
  });

  it("especialidade não abre conversa: o dono não tem RQE", () => {
    expect(abreConversa("especialidade")).toBe(false);
  });

  it("reclamação e os motivos que não são gatilho de assunto ficam de fora", () => {
    expect(abreConversa("reclamação")).toBe(false);
    expect(abreConversa("pergunta")).toBe(false);
    expect(abreConversa("vazio")).toBe(false);
    expect(abreConversa("sem padrão seguro reconhecido")).toBe(false);
    expect(abreConversa("texto longo demais")).toBe(false);
  });
});

describe("frasesDeGatilho — o texto que a pessoa recebe", () => {
  it("sem nada configurado, devolve as frases padrão", () => {
    expect(frasesDeGatilho(undefined)).toEqual(FRASES_PADRAO);
    expect(frasesDeGatilho(null)).toEqual(FRASES_PADRAO);
    expect(frasesDeGatilho({})).toEqual(FRASES_PADRAO);
  });

  it("o texto do dono vence o padrão, um gatilho de cada vez", () => {
    const frases = frasesDeGatilho({ preco: "Oi, o que você busca?" });
    expect(frases.preco).toBe("Oi, o que você busca?");
    expect(frases.agendamento).toBe(FRASES_PADRAO.agendamento);
  });

  it("apara o espaço em volta", () => {
    expect(frasesDeGatilho({ preco: "  Oi!  " }).preco).toBe("Oi!");
  });

  it("texto em branco NÃO apaga a frase: cai no padrão em vez de mandar vazio", () => {
    expect(frasesDeGatilho({ preco: "   " }).preco).toBe(FRASES_PADRAO.preco);
    expect(frasesDeGatilho({ preco: "" }).preco).toBe(FRASES_PADRAO.preco);
  });

  it("valor de tipo errado cai no padrão em vez de derrubar o worker", () => {
    expect(frasesDeGatilho({ preco: 42 }).preco).toBe(FRASES_PADRAO.preco);
    expect(frasesDeGatilho("nada disso")).toEqual(FRASES_PADRAO);
    expect(frasesDeGatilho([1, 2, 3])).toEqual(FRASES_PADRAO);
  });

  it("as frases padrão terminam em pergunta: é o que faz a conversa começar", () => {
    expect(FRASES_PADRAO.preco.trim().endsWith("?")).toBe(true);
    expect(FRASES_PADRAO.agendamento.trim().endsWith("?")).toBe(true);
  });

  it("nenhuma frase padrão cita valor nem chama o dono de especialista", () => {
    for (const frase of Object.values(FRASES_PADRAO)) {
      expect(frase).not.toMatch(/r\$|\bre[aá]is\b|\bpre[cç]o\b|\bvalor\b/iu);
      expect(frase).not.toMatch(/nutr[oó]log|especialist|http/iu);
    }
  });
});

describe("frasesComoGuardadas — o que a TELA edita", () => {
  it("organização que nunca configurou recebe campo vazio, NÃO o texto padrão", () => {
    // O defeito que o e2e pegou: a leitura resolvia o branco para o padrão
    // antes de entregar à tela, o campo vinha preenchido, e salvar CONGELAVA
    // a frase de fábrica de hoje dentro da organização. Quem resolve o branco
    // é o WORKER, na hora de mandar, não a tela.
    expect(frasesComoGuardadas(undefined)).toEqual({ preco: "", agendamento: "" });
    expect(frasesComoGuardadas({})).toEqual({ preco: "", agendamento: "" });
  });

  it("devolve o texto do dono como ele está guardado", () => {
    expect(frasesComoGuardadas({ preco: "  Minha frase  " })).toEqual({
      preco: "Minha frase",
      agendamento: "",
    });
  });

  it("valor de tipo errado não vaza para a tela", () => {
    expect(frasesComoGuardadas({ preco: 42 })).toEqual({ preco: "", agendamento: "" });
    expect(frasesComoGuardadas("nada disso")).toEqual({ preco: "", agendamento: "" });
  });
});
