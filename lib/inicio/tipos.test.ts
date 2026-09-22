import { describe, expect, it } from "vitest";
import { janelaDeHoje } from "./tipos";

describe("janelaDeHoje", () => {
  it("23:30 em São Paulo ainda é o mesmo dia, embora já seja amanhã em UTC", () => {
    const agora = new Date("2026-09-22T02:30:00Z"); // 21/09 23:30 BRT
    const j = janelaDeHoje(agora, "America/Sao_Paulo");
    expect(j.dia).toBe("2026-09-21");
    expect(j.inicio).toBe("2026-09-21T03:00:00.000Z");
    expect(j.fim).toBe("2026-09-22T03:00:00.000Z");
  });
  it("fuso inválido cai no padrão em vez de lançar", () => {
    const j = janelaDeHoje(new Date("2026-09-21T15:00:00Z"), "Nao/Existe");
    expect(j.dia).toBe("2026-09-21");
  });
});
