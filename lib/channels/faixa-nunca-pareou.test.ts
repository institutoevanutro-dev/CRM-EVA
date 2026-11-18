import { describe, expect, it } from "vitest";

import { conexoesCaidasDe, listarConexoesCaidas, nuncaPareou } from "./health";

/** Auditoria de 17/11, item 58: conexão por QR que nunca pareou não vira faixa. */
describe("faixa de conexão caída", () => {
  it("QR sem número nunca pareou; com número, pareou; Instagram (sem número por natureza) não entra na regra", () => {
    expect(nuncaPareou({ provider: "waha", phone_number: null })).toBe(true);
    expect(nuncaPareou({ provider: "waha", phone_number: "5527999990000" })).toBe(false);
    expect(nuncaPareou({ provider: "meta_instagram", phone_number: null })).toBe(false);
  });

  it("o servidor (primeira pintura) aplica a mesma regra", async () => {
    const linhas = [
      { id: "a", display_name: null, phone_number: null, status: "SCAN_QR_CODE", provider: "waha" },
      { id: "b", display_name: "Recepção", phone_number: "5527999990000", status: "FAILED", provider: "waha" },
      { id: "c", display_name: "Instagram @clinica", phone_number: null, status: "STOPPED", provider: "meta_instagram" },
    ];
    const cadeia = { select: () => cadeia, eq: () => cadeia, is: () => cadeia, in: (col: string) => (col === "status" ? Promise.resolve({ data: linhas }) : cadeia) };
    const admin = { from: () => cadeia } as never;
    expect((await listarConexoesCaidas(admin, "org")).map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("CONTROLE — número que já pareou e caiu continua na faixa", () => {
    expect(conexoesCaidasDe([{ id: "b", display_name: "Recepção", status: "SCAN_QR_CODE", nunca_pareou: false }])).toEqual([
      { id: "b", apelido: "Recepção", status: "SCAN_QR_CODE" },
    ]);
  });
});
