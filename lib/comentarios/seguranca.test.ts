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

it.each(inseguros)("%s precisa de você (%s)", (texto) => {
  expect(ehObviamenteSeguro(texto).seguro).toBe(false);
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
