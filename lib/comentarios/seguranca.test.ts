import { expect, it } from "vitest";
import { ehObviamenteSeguro } from "./seguranca";

const inseguros: [string, string][] = [
  ["quanto custa?", "preço"], ["qual o valor da consulta", "preço"], ["tem desconto?", "preço"],
  ["posso tomar mounjaro?", "medicação"], ["qual a dose de tirzepatida", "medicação"],
  ["serve pra quem tem tireoide?", "sintoma"], ["senti tontura, é normal?", "sintoma"],
  ["como agendo?", "agendamento"], ["tem horário amanhã?", "agendamento"],
  ["paguei e ninguém me respondeu", "reclamação"], ["que golpe é esse", "reclamação"],
  ["você é nutrólogo?", "especialidade"], ["qual sua especialidade?", "especialidade"],
];

it.each(inseguros)("%s precisa de você (%s)", (texto, categoria) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: false, gatilho: categoria });
});

// Prova de mutação (mantida): elogio na frente não muda o veredito — mata o
// mutante que fazia "obviamente seguro" casar SUBSTRING em vez do texto
// inteiro. Sem o ancoramento ao texto todo, "amei, quanto custa?" passaria.
it.each(inseguros)('"amei, %s" continua inseguro (elogio não desarma o gatilho)', (texto) => {
  expect(ehObviamenteSeguro(`amei, ${texto}`).seguro).toBe(false);
});

const seguros = ["top!", "amei 😍", "🔥🔥🔥", "parabéns doutor", "que vídeo bom"];
it.each(seguros)("%s é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

it("na dúvida, é inseguro: pergunta que não é elogio não passa", () => {
  expect(ehObviamenteSeguro("e para quem tem 60 anos?").seguro).toBe(false);
});

it("texto vazio ou nulo não é publicável", () => {
  expect(ehObviamenteSeguro(null).seguro).toBe(false);
  expect(ehObviamenteSeguro("   ").seguro).toBe(false);
});

it("elogio com pergunta retórica continua inseguro (a régua é conservadora)", () => {
  expect(ehObviamenteSeguro("amei! onde compro?").seguro).toBe(false);
});

// ── casos que a revisão pegou na ronda 1 (não podem voltar a passar) ────────
const naoPodemVoltarAPassar = [
  "top! estou amamentando, posso usar a caneta",
  "amei, sou diabético tipo 1, posso aplicar",
  "show! tomo losartana, tem interação",
  "amei! onde compro",
  "top, quais os preços",
  "top, cuánto cuesta",
  "parabéns, o senhor trata obesidade infantil",
];

it.each(naoPodemVoltarAPassar)("%s não pode ser publicado sozinho", (texto) => {
  expect(ehObviamenteSeguro(texto).seguro).toBe(false);
});

// ── espanhol: vocabulário inequívoco também precisa de humano ───────────────
const inegurosEmEspanhol: [string, string][] = [
  ["cuánto cuesta?", "preço"],
  ["cual es el precio?", "preço"],
  ["puedo tomar ozempic?", "medicação"],
  ["eres nutriologo?", "especialidade"],
  ["tienes cita manana?", "agendamento"],
];

it.each(inegurosEmEspanhol)("%s precisa de você em espanhol (%s)", (texto, categoria) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: false, gatilho: categoria });
});

// ── texto longo não é "obviamente seguro", mesmo sendo TODO vocabulário seguro ─
it("texto longo demais não é obviamente seguro, mesmo com todo token conhecido", () => {
  const longo =
    "muito obrigada doutor, que aula maravilhosa, perfeito, excelente, adorei o video, top demais, parabens, show de bola, sucesso";
  expect(longo.length).toBeGreaterThan(120);
  expect(ehObviamenteSeguro(longo)).toEqual({ seguro: false, gatilho: "texto longo demais" });
});

// ── emoji com variation selector e ZWJ também é "só emoji" ──────────────────
it.each(["❤️", "👨🏽‍⚕️"])("%s (emoji com modificador) é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

// ── RONDA 2 (revisão): critério trocado de "frase fechada" pra "todo token no
// vocabulário" — elogio de verdade não sai só nas frases prontas da ronda 1.
// Estes dez são exatamente os que a medição da revisão marcou como recusados
// indevidamente; agora precisam ser seguros. ──────────────────────────────────
const elogiosReaisQuePrecisamPassar = [
  "muito bom esse conteúdo",
  "adorei o vídeo",
  "excelente explicação",
  "que aula!",
  "obrigada doutor 🙏",
  "top demais",
  "amei o conteúdo",
  "perfeito",
  "show de bola",
  "melhor explicação que já vi",
];

it.each(elogiosReaisQuePrecisamPassar)("%s é elogio real e tem de ser seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

// O princípio da ronda 2: mesmo começo, um token desconhecido no fim já vira
// tudo inseguro — é o que faz o vocabulário seguro compor frase sem abrir mão
// do deny-by-default.
it("mesmo começo, um token desconhecido no fim reprova o texto inteiro", () => {
  expect(ehObviamenteSeguro("amei o conteúdo")).toEqual({ seguro: true });
  expect(ehObviamenteSeguro("amei o conteúdo, qual a dose").seguro).toBe(false);
});
