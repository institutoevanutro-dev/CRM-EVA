import { describe, expect, it } from "vitest";

import { camposMexidos, mesclarEtiquetas, rebaseCampos } from "./rebase-do-dossie";

describe("rebase do dossiê (achado 6)", () => {
  it("campo não mexido acompanha o servidor; o mexido fica com quem edita", () => {
    const base = { a: "1", b: "1" };
    expect(rebaseCampos(base, { a: "1", b: "meu" }, { a: "ia", b: "1" })).toEqual({ a: "ia", b: "meu" });
  });
  it("só o que difere da base viaja", () => {
    expect(camposMexidos({ a: "1", b: "1" }, { a: "1", b: "2" })).toEqual({ b: "2" });
  });
  it("etiquetas: acrescentar e tirar aplicam sobre o conjunto do servidor", () => {
    expect(mesclarEtiquetas(["x", "y"], ["y", "z"], ["x", "y", "ia"])).toEqual(["y", "ia", "z"]);
  });
});
