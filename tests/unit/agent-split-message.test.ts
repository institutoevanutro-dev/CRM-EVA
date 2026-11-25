// tests/unit/agent-split-message.test.ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { instrucaoDeBolhas, splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

describe("splitIntoBubbles", () => {
  it("texto curto vira uma bolha só (trim)", () => {
    expect(splitIntoBubbles("  Olá, tudo bem?  ", 600)).toEqual(["Olá, tudo bem?"]);
  });
  it("vazio/whitespace → []", () => {
    expect(splitIntoBubbles("", 600)).toEqual([]);
    expect(splitIntoBubbles("   \n  ", 600)).toEqual([]);
  });
  it("quebra por parágrafo quando cabe", () => {
    const out = splitIntoBubbles("Primeiro parágrafo.\n\nSegundo parágrafo.", 30);
    expect(out).toEqual(["Primeiro parágrafo.", "Segundo parágrafo."]);
  });
  it("nenhuma bolha excede maxChars (quebra por sentença)", () => {
    const text = "Oi! Como você está hoje? Queria falar do seu pedido. Ele já saiu para entrega.";
    const out = splitIntoBubbles(text, 30);
    expect(out.every((b) => b.length <= 30)).toBe(true);
    expect(out.join(" ")).toContain("pedido");
  });
  it("junta sentenças curtas adjacentes até o teto", () => {
    const out = splitIntoBubbles("Oi. Tudo bem? Beleza.", 100);
    expect(out).toHaveLength(1); // tudo cabe em 100
  });
  it("palavra única maior que o teto vai sozinha (não corta no meio)", () => {
    const big = "a".repeat(50);
    const out = splitIntoBubbles(`curto ${big} fim`, 20);
    expect(out).toContain(big);
    expect(out.every((b) => b.length > 0)).toBe(true);
  });
  it("não perde texto quando o ponto não é seguido de espaço (preço decimal)", () => {
    const out = splitIntoBubbles(
      "Seu pedido de R$149.90 já saiu para entrega hoje as 14h no bairro central.",
      30,
    );
    expect(out.join(" ")).toContain("Seu pedido");
    expect(out.join(" ")).toContain("149");
    expect(out.join(" ")).toContain("central");
  });

  it("nunca parte um valor em reais no separador de milhar (R$ 10.990) entre bolhas", () => {
    // Bug real (YADEA, 2026-09-04): "R$ 10.990" virava bolha "R$ 10." + bolha
    // "990 no cartão…" — o cliente que via só a primeira lia "R$ 10" como o
    // preço de uma moto de R$ 10.990.
    const out = splitIntoBubbles(
      "Temos a DT3 por R$ 9.990 à vista no Pix ou R$ 10.990 no cartão em até 12x sem juros.",
      40,
    );
    for (const bubble of out) {
      expect(bubble).not.toMatch(/\d\.\s*$/); // nenhuma bolha termina em "dígito."
    }
    expect(out.join(" ")).toContain("10.990");
    expect(out.join(" ")).toContain("9.990");
  });

  it("não insere espaço espúrio dentro de um valor em reais (R$ 7. 990)", () => {
    const out = splitIntoBubbles("O valor é R$ 7.990 à vista no Pix.", 30);
    expect(out.join(" ")).not.toContain("7. 990");
    expect(out.join(" ")).toContain("7.990");
  });
});

// O parágrafo é a fronteira da bolha (medido em produção no original, 26/09/2026:
// com os parágrafos juntados até o teto, a opção não tinha ajuste — teto alto
// virava uma bolha só, teto baixo picotava o resumo no meio da linha).
// Portado de melgarafael/DeskcommCRM 52384bf2d (autor: jmpo).
describe("splitIntoBubbles — o parágrafo é a bolha", () => {
  it("três parágrafos curtos saem em três bolhas, na ordem, mesmo cabendo numa só", () => {
    const texto = "Olá! Tudo bem? 😊\n\nSim, atendemos pelo convênio.\n\nQuer que eu reserve?";
    expect(splitIntoBubbles(texto, 600)).toEqual([
      "Olá! Tudo bem? 😊",
      "Sim, atendemos pelo convênio.",
      "Quer que eu reserve?",
    ]);
  });

  it("o resumo do agendamento — uma linha por item — sai inteiro, com as quebras de linha", () => {
    const resumo = [
      "Resumo do seu agendamento:",
      "🩺 Consulta com a Drª Mara",
      "📍 Unidade Centro, sala 2",
      "🕚 Amanhã às 11h",
      "Confirmamos assim?",
    ].join("\n");
    expect(splitIntoBubbles(resumo, 600)).toEqual([resumo]);
  });

  it("só o parágrafo que estoura o teto é partido, e dentro dele", () => {
    const texto = "Curto.\n\nPrimeira frase longa aqui. Segunda frase longa aqui.";
    expect(splitIntoBubbles(texto, 30)).toEqual([
      "Curto.",
      "Primeira frase longa aqui.",
      "Segunda frase longa aqui.",
    ]);
  });
});

// Com a instrução antiga ("Prefira várias mensagens curtas a um texto único e
// longo"), o modelo chamava send_message várias vezes no mesmo passo — chamadas
// paralelas, que chegam fora de ordem. A instrução pede UM envio em parágrafos,
// e o corte do sistema cumpre o que ela promete: partir nos parágrafos, em ordem.
describe("splitIntoBubbles — ponto que não é fim de frase", () => {
  // "Oi." cabe junto do pedaço até a abreviação; se o ponto dela contar como
  // fim de frase, a bolha fecha ali e a frase não sai inteira.
  const inteira = (frase: string) =>
    expect(splitIntoBubbles(`Oi. ${frase} Tchau.`, frase.length)).toEqual(["Oi.", frase, "Tchau."]);

  it("a frase medida em produção (2026-10-12) não parte em 'Dr.' | 'Otávio'", () => {
    const out = splitIntoBubbles(
      "Temos duas formas de começar com o Dr. Otávio: a consulta de R$490, que já inclui a avaliação completa e o plano alimentar, ou o acompanhamento de três meses por R$ 2.387,60, com retornos quinzenais e ajuste do plano a cada encontro. Qual das duas faz mais sentido para você agora?",
      200,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((b) => b.length <= 200)).toBe(true);
    expect(out.some((b) => b.endsWith("Dr."))).toBe(false);
    expect(out.some((b) => b.startsWith("Otávio"))).toBe(false);
    expect(out[0]).toContain("Dr. Otávio: a consulta de R$490");
  });

  it.each([
    "A consulta com o Dr. Otávio é na terça.",
    "Quem atende é a Dra. Carla Mendes.",
    "O horário do Sr. João ficou para as 15h.",
    "Confirmei com a Sra. Maria Helena.",
    "A aula é com o Prof. Lima na quinta.",
    "A turma da Profa. Ana começa em março.",
    "Estamos na Av. Paulista, perto do metrô.",
    "A entrada é pela R. Augusta, ao lado da farmácia.",
    "O consultório fica no Nº. 120 da rua.",
    "O prédio é o de n. 45, na esquina.",
    "Leve um documento, p. ex. o RG ou a CNH.",
    "Exames como hemograma, p. ex. Hemograma Completo, entram.",
    "Traga exames, receitas etc. no dia da consulta.",
    // Plural e títulos profissionais (do original, #5186).
    "Atendem os Drs. Paulo e André às terças.",
    "As Dras. Ana e Bia atendem às sextas.",
    "Os Srs. Lima e Costa chegaram cedo.",
    "As Sras. Maria e Ana confirmaram.",
    "As Srtas. Lia e Bia vêm juntas.",
    "Os Profs. Lima e Souza dão a aula.",
    "Quem assina é o Eng. Carlos Lima.",
    "Quem assina é a Enga. Carla Lima.",
    "O projeto é do Arq. Bruno Reis.",
    "Fale com o Adv. Pedro Melo hoje.",
  ])("abreviação em português: %s", (frase) => inteira(frase));

  it.each([
    "La consulta es con el Dr. Ramírez el martes.",
    "Le atiende la Dra. López por la tarde.",
    "El turno del Sr. Gómez quedó confirmado.",
    "Ya hablé con la Sra. Fernández hoy.",
    "El plan queda para Ud. María, sin costo.",
    "La agenda de Uds. Pérez y Díaz está lista.",
    "La firma la Lic. Romero mañana.",
    "El informe es del Ing. Torres hoy.",
  ])("abreviação em espanhol: %s", (frase) => inteira(frase));

  it.each([
    "O pacote completo sai por R$ 2.387,60 no cartão.",
    "A dose inicial é de 1.5 mg por dia.",
    "O último horário é às 18.30 na sexta.",
    "Agende em https://clinica.com.br/agenda quando quiser.",
  ])("número, horário e endereço web: %s", (frase) => inteira(frase));

  it("continua quebrando no fim de frase de verdade, depois do nome", () => {
    expect(splitIntoBubbles("Falei com o Dr. Otávio. Ele confirma amanhã cedo.", 30)).toEqual([
      "Falei com o Dr. Otávio.",
      "Ele confirma amanhã cedo.",
    ]);
  });
});

// Abreviação não é fim de frase. Medido em produção no original (23/11/2026,
// clínica): um parágrafo de 405 caracteres, com teto de 250, saiu em duas
// mensagens do WhatsApp partidas em "Antes, o Dr." | "avalia seu sorriso…".
// Portado de melgarafael/DeskcommCRM#5186 (autor: Alecsander Abreu).
describe("splitIntoBubbles — abreviação não termina a frase", () => {
  const terminaEmAbreviacao = /\b(Dr|Dra|Sr|Sra|Srta|Prof|Profa)\.$/;

  it("o parágrafo real da clínica não sai partido em 'o Dr.' | 'avalia…'", () => {
    const texto =
      "Oi, Carla! Boa tarde. Aqui é a Ana, da equipe do Dr. Paulo. A faceta em resina é feita diretamente no consultório e geralmente em uma sessão mais longa. Antes, o Dr. avalia seu sorriso e planeja o tratamento de forma individual, priorizando a saúde e a função dos dentes para buscar um resultado natural. O que mais você gostaria de mudar no seu sorriso: a cor, o formato, o tamanho ou o alinhamento?";
    const out = splitIntoBubbles(texto, 250);
    expect(out.length).toBeGreaterThan(1); // continua partindo: o parágrafo passa do teto
    for (const bolha of out) {
      expect(bolha).not.toMatch(terminaEmAbreviacao);
      expect(bolha.length).toBeLessThanOrEqual(250);
    }
    expect(out.join(" ")).toContain("o Dr. avalia seu sorriso");
    expect(out.join(" ")).toBe(texto);
  });

  it("título seguido do nome (Dr. Paulo) não vira duas bolhas", () => {
    const texto =
      "A faceta em porcelana custa a partir de R$ 2.700 por dente. O total exato é definido na avaliação com o Dr. Paulo, que examina o sorriso e monta o planejamento.";
    const out = splitIntoBubbles(texto, 120);
    for (const bolha of out) expect(bolha).not.toMatch(terminaEmAbreviacao);
    expect(out.join(" ")).toContain("com o Dr. Paulo");
  });

  it("vale para o espanhol e para o feminino (Dra., Sra.)", () => {
    const texto =
      "La Dra. Gómez atiende los lunes y los jueves. La Sra. Pérez confirma su cita por este mismo número.";
    const out = splitIntoBubbles(texto, 60);
    for (const bolha of out) expect(bolha).not.toMatch(terminaEmAbreviacao);
    expect(out.join(" ")).toContain("La Dra. Gómez");
    expect(out.join(" ")).toContain("La Sra. Pérez");
  });

  it("ponto seguido de minúscula não termina a frase (etc. e…)", () => {
    const out = splitIntoBubbles(
      "Levamos escova, fio, creme etc. e o kit de clareamento para a sua avaliação de amanhã.",
      70,
    );
    for (const bolha of out) expect(bolha).not.toMatch(/etc\.$/);
  });

  it("o fim de frase de verdade continua partindo o parágrafo que estoura", () => {
    const out = splitIntoBubbles(
      "A avaliação é com o Dr. Paulo. Ela leva de 40 minutos a 1 hora. O endereço fica no centro.",
      40,
    );
    expect(out).toEqual([
      "A avaliação é com o Dr. Paulo.",
      "Ela leva de 40 minutos a 1 hora.",
      "O endereço fica no centro.",
    ]);
  });
});

describe("instrucaoDeBolhas", () => {
  it("desligado não diz nada ao modelo", () => {
    expect(instrucaoDeBolhas(false)).toBe("");
  });

  it("ligado pede UM envio em parágrafos — nunca várias chamadas de send_message", () => {
    const t = instrucaoDeBolhas(true);
    expect(t).toMatch(/ÚNICA chamada de send_message/);
    expect(t).toMatch(/parágrafos curtos separados por uma linha em branco/);
    expect(t).toMatch(/Resposta curta vai num parágrafo só/);
    expect(t).toMatch(/Nunca chame send_message mais de uma vez/);
    expect(t).not.toMatch(/várias mensagens/i);
  });

  it("o turno usa esta instrução, e não um texto próprio", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno).toMatch(/instrucaoDeBolhas\(agentConfig\?\.splitMessages/);
    expect(turno).not.toMatch(/Prefira várias mensagens curtas/);
  });
});
