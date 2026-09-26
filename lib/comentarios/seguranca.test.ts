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

// ── texto longo não é "obviamente seguro", mesmo sem gatilho nenhum ─────────
it("texto longo demais não é obviamente seguro", () => {
  const longo = "muito obrigada por tudo, vocês são demais, equipe incrível, adorei o atendimento";
  expect(longo.length).toBeGreaterThan(60);
  expect(ehObviamenteSeguro(longo).seguro).toBe(false);
});

// ── emoji com variation selector e ZWJ também é "só emoji" ──────────────────
it.each(["❤️", "👨🏽‍⚕️"])("%s (emoji com modificador) é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});
