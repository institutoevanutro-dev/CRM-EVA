import { describe, expect, it } from "vitest";

import { podeCombinarAtendimentos } from "@/lib/agenda/recursos";

describe("capacidade simultânea da agenda", () => {
  it("permite intravenosa com intramuscular quando há duas salas", () => {
    expect(podeCombinarAtendimentos({ capacidade: 2, chavesExistentes: ["iv"], chaveNova: "im" })).toBe(true);
  });

  it("recusa duas intravenosas simultâneas", () => {
    expect(podeCombinarAtendimentos({ capacidade: 2, chavesExistentes: ["iv"], chaveNova: "iv" })).toBe(false);
  });

  it("recusa qualquer simultaneidade quando só há uma sala", () => {
    expect(podeCombinarAtendimentos({ capacidade: 1, chavesExistentes: ["iv"], chaveNova: "im" })).toBe(false);
  });

  it("não libera simultaneidade sem classificação explícita", () => {
    expect(podeCombinarAtendimentos({ capacidade: 3, chavesExistentes: [null], chaveNova: null })).toBe(false);
  });
});
