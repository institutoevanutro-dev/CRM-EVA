import { describe, expect, it } from "vitest";

import { lerMarcaDaTroca, marcaDaTroca, PRAZO_DA_TROCA_S } from "./troca-de-senha";

describe("marca da troca de senha", () => {
  it("lê de volta o que gravou", () => {
    expect(lerMarcaDaTroca(marcaDaTroca("u1", "ana@exemplo.test"))).toEqual({ userId: "u1", email: "ana@exemplo.test" });
  });

  it("recusa marca forjada (corpo trocado, assinatura velha)", () => {
    const [, sig] = marcaDaTroca("u1", "ana@exemplo.test").split(".");
    const corpo = Buffer.from(JSON.stringify({ u: "u2", e: "outra@exemplo.test", exp: 9999999999 })).toString("base64url");
    expect(lerMarcaDaTroca(`${corpo}.${sig}`)).toBeNull();
    expect(lerMarcaDaTroca("u2")).toBeNull();
  });

  it("recusa marca vencida", () => {
    const agora = Date.now();
    const marca = marcaDaTroca("u1", "ana@exemplo.test", agora);
    expect(lerMarcaDaTroca(marca, agora + (PRAZO_DA_TROCA_S + 1) * 1000)).toBeNull();
  });
});
