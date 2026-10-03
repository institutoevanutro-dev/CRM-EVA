import { describe, expect, it } from "vitest";

import {
  MARGEM_OUTRO_ITEM,
  LIMITE_PADRAO,
  TAMANHO_MAXIMO,
  decidirRespostaPronta,
  sinalClinico,
  textoParaComparar,
  umAssuntoSo,
} from "@/lib/respostas-prontas/casamento";

/**
 * As três travas, sem banco e sem rede. A trava 3 é textual e se prova aqui com
 * frases reais de clínica odontológica. As travas 1 e 2 recebem a similaridade
 * POR ITEM já calculada; aqui elas são exercitadas com mapas sintéticos — o
 * corpus semântico, com similaridades do modelo real, é a Tarefa 3.
 */

describe("textoParaComparar — a saudação não é o assunto", () => {
  it("tira a saudação do começo e mantém a pergunta", () => {
    expect(textoParaComparar(["Oi, boa tarde! Qual o valor da profilaxia?"])).toBe("Qual o valor da profilaxia?");
    expect(textoParaComparar(["Olá! Tudo bem? Vocês atendem sábado?"])).toBe("Vocês atendem sábado?");
  });

  it("rajada: junta o que o cliente disse desde a nossa última resposta", () => {
    expect(textoParaComparar(["oi", "quanto custa a limpeza?"])).toBe("quanto custa a limpeza?");
  });

  it("não come pedaço de palavra que só COMEÇA como saudação", () => {
    expect(textoParaComparar(["Oito horas tem horário?"])).toBe("Oito horas tem horário?");
  });

  it("só saudação vira texto vazio", () => {
    expect(textoParaComparar(["Oi, boa tarde!"])).toBe("");
    expect(textoParaComparar(["   "])).toBe("");
  });
});

describe("trava 3 — mensagem curta e de um assunto só", () => {
  const PASSAM = [
    "Quanto custa a limpeza?",
    "quanto tá a limpeza",
    "Qual o valor da profilaxia?",
    "Vocês atendem sábado?",
    "Qual o endereço da clínica?",
    "Aceitam convênio Amil?",
    "Qual o horário de funcionamento, por favor?",
    "Quanto custa a limpeza, doutora?",
    "Quanto custa a limpeza, por favor?",
  ];
  for (const frase of PASSAM) {
    it(`passa: "${frase}"`, () => {
      expect(umAssuntoSo(textoParaComparar([frase]))).toEqual({ ok: true });
    });
  }

  const REPROVAM: Array<[string, string]> = [
    ["Quanto custa a limpeza e tem horário amanhã?", "mais_de_um_assunto"],
    ["Qual o endereço e o horário?", "mais_de_um_assunto"],
    ["quero marcar uma limpeza e saber o preço", "mais_de_um_assunto"],
    ["Quanto custa a limpeza e clareamento?", "mais_de_um_assunto"],
    ["valor da limpeza e clareamento", "mais_de_um_assunto"],
    ["Quanto custa a limpeza? E o clareamento?", "mais_de_uma_pergunta"],
    [`Quanto custa a limpeza? ${"Estou com uma dúvida grande sobre o tratamento todo. ".repeat(3)}`, "mensagem_longa"],
    ["", "vazia"],
  ];
  for (const [frase, motivo] of REPROVAM) {
    it(`reprova (${motivo}): "${frase.slice(0, 50)}"`, () => {
      expect(umAssuntoSo(textoParaComparar([frase]))).toEqual({ ok: false, motivo });
    });
  }

  it("o limite de tamanho é medido DEPOIS de tirar a saudação", () => {
    const pergunta = `Qual o valor ${"x".repeat(TAMANHO_MAXIMO - 20)}?`;
    expect(pergunta.length).toBeLessThanOrEqual(TAMANHO_MAXIMO);
    expect(umAssuntoSo(textoParaComparar([`Oi, boa tarde! ${pergunta}`]))).toEqual({ ok: true });
  });
});

describe("travas 1 e 2 — similaridade por item", () => {
  it("casa quando o melhor item passa do limite e nenhum outro chega perto", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.9], ["horario", 0.55]]), LIMITE_PADRAO);
    expect(d).toEqual({ casou: true, respostaProntaId: "limpeza", similaridade: 0.9 });
  });

  it("trava 1: abaixo do limite não casa", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.81]]), LIMITE_PADRAO);
    expect(d).toEqual({ casou: false, motivo: "abaixo_do_limite", similaridade: 0.81 });
  });

  it("trava 2: outro item colado no melhor (dentro da margem) é assunto misturado", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.88], ["clareamento", 0.84]]), LIMITE_PADRAO);
    expect(d).toEqual({ casou: false, motivo: "assunto_misturado", similaridade: 0.88 });
  });

  it("trava 2 é relativa: irmão a 0,75 com o melhor a 0,88 (pergunta de preço) responde", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.88], ["clareamento", 0.75]]), LIMITE_PADRAO);
    expect(d).toEqual({ casou: true, respostaProntaId: "limpeza", similaridade: 0.88 });
  });

  it("trava 2: outro item fora da margem responde; abaixo do limite, a trava 1 vale primeiro", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.745], ["clareamento", 0.69]]), LIMITE_PADRAO);
    expect(d.casou).toBe(false); // 0,745 < limite 0,82: trava 1 vale primeiro
    const ok = decidirRespostaPronta(new Map([["limpeza", 0.9], ["clareamento", 0.69]]), LIMITE_PADRAO);
    expect(ok.casou).toBe(true);
    expect(MARGEM_OUTRO_ITEM).toBe(0.06);
  });

  it("trava 2: borda — outro item exatamente em topo - margem e >= 0,70 é misturado", () => {
    const d = decidirRespostaPronta(new Map([["limpeza", 0.9], ["clareamento", 0.84]]), LIMITE_PADRAO);
    expect(d.casou).toBe(false);
  });

  it("o limite da clínica vale (mais rigoroso)", () => {
    expect(decidirRespostaPronta(new Map([["limpeza", 0.86]]), 0.9).casou).toBe(false);
  });

  it("sem candidato, ou só similaridade inválida (NaN do pgvector), não casa", () => {
    expect(decidirRespostaPronta(new Map(), LIMITE_PADRAO)).toEqual({
      casou: false,
      motivo: "sem_candidato",
      similaridade: null,
    });
    expect(decidirRespostaPronta(new Map([["limpeza", Number.NaN]]), LIMITE_PADRAO).casou).toBe(false);
  });

  it("limite corrompido (NaN) cai no padrão — nunca vira 'casa tudo'", () => {
    expect(decidirRespostaPronta(new Map([["limpeza", 0.5]]), Number.NaN).casou).toBe(false);
  });

  it("limite abaixo do piso é levado ao piso 0,78", () => {
    expect(decidirRespostaPronta(new Map([["limpeza", 0.6]]), 0.1).casou).toBe(false);
  });
});

describe("sinalClinico — dor e sintoma nunca recebem resposta pronta", () => {
  const CLINICOS = [
    "a limpeza doeu é normal?",
    "Estou com DOR depois da extração",
    "o dente dói quando bebo gelado",
    "tá doendo muito",
    "a gengiva ficou dolorida",
    "meu rosto está inchado",
    "a bochecha inchou",
    "a gengiva sangrou na escovação",
    "está sangrando",
    "tive febre ontem",
    "saiu pus do dente",
    "o dente quebrou",
    "a restauração lascou",
    "está latejando",
    "fiquei com sensibilidade depois do clareamento",
  ];
  const NEUTROS = [
    "Quanto custa a limpeza?",
    "Vocês atendem sábado?",
    "o dourado da coroa é ouro?",
    "a doutora atende amanhã?",
    "adorei o atendimento",
    "qual o endereço?",
  ];

  it.each(CLINICOS)("acha sintoma em %j", (t) => {
    expect(sinalClinico(t)).toBe(true);
  });

  it.each(NEUTROS)("não acha sintoma em %j", (t) => {
    expect(sinalClinico(t)).toBe(false);
  });
});
