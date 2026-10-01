import { describe, expect, it } from "vitest";

import { tipoDoCrm } from "./ingest";

describe("tipoDoCrm", () => {
  it("passa os tipos do CHECK intactos", () => {
    for (const t of ["text", "image", "video", "audio", "document", "sticker", "location", "contact", "reaction", "system", "template"]) {
      expect(tipoDoCrm(t)).toEqual({ type: t, bodyDeSistema: null });
    }
  });
  it("contacts (plural da Meta) vira contact", () => {
    expect(tipoDoCrm("contacts")).toEqual({ type: "contact", bodyDeSistema: null });
  });
  it("sem equivalente vira system com o rótulo", () => {
    for (const t of ["interactive", "button", "order", "unsupported", "unknown", ""]) {
      expect(tipoDoCrm(t)).toEqual({ type: "system", bodyDeSistema: `[${t || "unknown"}]` });
    }
  });
});
