import { describe, expect, it } from "vitest";
import { deCadaDez, janelasDosPaineis, origemDoContato } from "./paineis";

// Spec 2026-10-07-inicio-paineis: janelas no fuso da organização.
const AGORA = new Date("2026-10-07T15:00:00Z"); // 12:00 em São Paulo, quarta-feira
const FUSO = "America/Sao_Paulo";

describe("janelasDosPaineis", () => {
  const j = janelasDosPaineis(AGORA, FUSO);
  it("conversas: 30 dias terminando hoje", () => {
    expect(j.conversas.inicio).toBe("2026-09-08T03:00:00.000Z");
    expect(j.conversas.fim).toBe("2026-10-08T03:00:00.000Z");
  });
  it("semana de segunda a domingo", () => {
    expect(j.semana).toMatchObject({ de: "2026-10-05", ate: "2026-10-11" });
    expect(j.semana.inicio).toBe("2026-10-05T03:00:00.000Z");
    expect(j.semana.fim).toBe("2026-10-12T03:00:00.000Z");
  });
  it("domingo pertence à semana que começou na segunda anterior", () => {
    const domingo = janelasDosPaineis(new Date("2026-10-11T20:00:00Z"), FUSO);
    expect(domingo.semana.de).toBe("2026-10-05");
  });
  it("mês atual inteiro", () => {
    expect(j.mes).toEqual({ inicio: "2026-10-01T03:00:00.000Z", fim: "2026-11-01T03:00:00.000Z", de: "2026-10-01" });
  });
  it("mês anterior: os MESMOS DIAS, até o mesmo dia e hora de agora — nunca o mês inteiro", () => {
    // Agora é 07/10 12:00 em São Paulo: a comparação vai de 01/09 até 07/09 12:00.
    expect(j.mesAnterior).toEqual({
      inicio: "2026-09-01T03:00:00.000Z",
      fim: "2026-09-07T15:00:00.000Z",
      de: "2026-09-01",
    });
  });
  it("virada de ano", () => {
    const jan = janelasDosPaineis(new Date("2026-01-10T15:00:00Z"), FUSO);
    expect(jan.mesAnterior).toMatchObject({ inicio: "2025-12-01T03:00:00.000Z", fim: "2025-12-10T15:00:00.000Z" });
  });
  it("mês anterior mais curto: 31 de março compara com fevereiro inteiro, sem invadir março", () => {
    const marco = janelasDosPaineis(new Date("2026-03-31T15:00:00Z"), FUSO);
    expect(marco.mesAnterior).toMatchObject({ inicio: "2026-02-01T03:00:00.000Z", fim: "2026-03-01T03:00:00.000Z" });
    // 29/03 também não existe em fevereiro de 2026 (28 dias).
    expect(janelasDosPaineis(new Date("2026-03-29T15:00:00Z"), FUSO).mesAnterior.fim).toBe("2026-03-01T03:00:00.000Z");
    // 28/03 existe: para no mesmo instante de 28/02.
    expect(janelasDosPaineis(new Date("2026-03-28T15:00:00Z"), FUSO).mesAnterior.fim).toBe("2026-02-28T15:00:00.000Z");
  });
  it("o dia é o do fuso da organização, não o do servidor: 01:00 UTC do dia 1 ainda é dia 31 em São Paulo", () => {
    const viradaUtc = janelasDosPaineis(new Date("2026-11-01T01:00:00Z"), FUSO); // 31/10 22:00 local
    expect(viradaUtc.mes.de).toBe("2026-10-01");
    // 31/10 × setembro (30 dias): setembro inteiro.
    expect(viradaUtc.mesAnterior).toMatchObject({ de: "2026-09-01", fim: "2026-10-01T03:00:00.000Z" });
  });
  it("primeiro instante do mês: a janela anterior é vazia, não negativa", () => {
    const inicio = janelasDosPaineis(new Date("2026-10-01T03:00:00Z"), FUSO);
    expect(inicio.mesAnterior.fim).toBe(inicio.mesAnterior.inicio);
  });
});

describe("deCadaDez", () => {
  const soma = (r: { equipe: number; ia: number; semResposta: number } | null) => (r ? r.equipe + r.ia + r.semResposta : null);
  it("reparte 10 pelo maior resto — a soma é sempre 10", () => {
    // 1/3 cada: 3,33 → 3+3+3 = 9; o que sobra vai ao primeiro do empate (equipe).
    expect(deCadaDez({ equipe: 1, ia: 1, semResposta: 1 })).toEqual({ equipe: 4, ia: 3, semResposta: 3 });
    // 55% · 38% · 7%: 5,5 · 3,8 · 0,7 → 5+3+0 = 8; sobram 2 para os maiores restos (3,8 e 0,7).
    expect(deCadaDez({ equipe: 55, ia: 38, semResposta: 7 })).toEqual({ equipe: 5, ia: 4, semResposta: 1 });
    for (const n of [
      { equipe: 7, ia: 2, semResposta: 1 },
      { equipe: 123, ia: 456, semResposta: 789 },
      { equipe: 1, ia: 0, semResposta: 999 },
      { equipe: 2, ia: 2, semResposta: 3 },
    ]) expect(soma(deCadaDez(n))).toBe(10);
  });
  it("proporção exata não é arredondada", () => {
    expect(deCadaDez({ equipe: 30, ia: 50, semResposta: 20 })).toEqual({ equipe: 3, ia: 5, semResposta: 2 });
    expect(deCadaDez({ equipe: 0, ia: 4, semResposta: 0 })).toEqual({ equipe: 0, ia: 10, semResposta: 0 });
  });
  it("sem conversa nova não há frase", () => {
    expect(deCadaDez({ equipe: 0, ia: 0, semResposta: 0 })).toBeNull();
  });
});

describe("origemDoContato", () => {
  it.each([
    ["meta_ads", "anuncio_meta"],
    ["google_ads", "anuncio_google"],
    ["whatsapp", "whatsapp"],
    ["webhook", "formulario"],
    ["prontuario_eva", "prontuario"],
    ["manual", "manual"],
    ["", "manual"],
    ["qualquer", "outros"],
  ])("%s → %s", (fonte, esperado) => {
    expect(origemDoContato(fonte)).toBe(esperado);
  });
});
