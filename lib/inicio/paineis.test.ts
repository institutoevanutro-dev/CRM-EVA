import { describe, expect, it } from "vitest";
import { janelasDosPaineis, origemDoContato, preencherDias } from "./paineis";

// Spec 2026-10-07-inicio-paineis: janelas no fuso da organização.
const AGORA = new Date("2026-10-07T15:00:00Z"); // 12:00 em São Paulo, quarta-feira
const FUSO = "America/Sao_Paulo";

describe("janelasDosPaineis", () => {
  const j = janelasDosPaineis(AGORA, FUSO);
  it("conversas: 30 dias terminando hoje", () => {
    expect(j.conversas.dias).toHaveLength(30);
    expect(j.conversas.dias[0]).toBe("2026-09-08");
    expect(j.conversas.dias[29]).toBe("2026-10-07");
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
  it("mês atual e anterior", () => {
    expect(j.mes).toEqual({ inicio: "2026-10-01T03:00:00.000Z", fim: "2026-11-01T03:00:00.000Z" });
    expect(j.mesAnterior).toEqual({ inicio: "2026-09-01T03:00:00.000Z" });
  });
  it("virada de ano", () => {
    const jan = janelasDosPaineis(new Date("2026-01-10T15:00:00Z"), FUSO);
    expect(jan.mesAnterior.inicio).toBe("2025-12-01T03:00:00.000Z");
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

describe("preencherDias", () => {
  it("dia sem conversa vira zeros, na ordem", () => {
    const r = preencherDias(["2026-10-01", "2026-10-02"], [
      { dia: "2026-10-02", ia_sozinha: 3, com_equipe: 1, sem_resposta: 0 },
    ]);
    expect(r).toEqual([
      { dia: "2026-10-01", ia_sozinha: 0, com_equipe: 0, sem_resposta: 0 },
      { dia: "2026-10-02", ia_sozinha: 3, com_equipe: 1, sem_resposta: 0 },
    ]);
  });
});
