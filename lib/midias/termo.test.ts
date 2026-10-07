import { describe, expect, it } from "vitest";

import { hojeNaClinica, situacaoDaMidia, type ItemDeMidia } from "./termo";

const arquivo = [{ key: "A" as const, storage_path: "o/i/A-1.mp4", mime: "video/mp4", size_bytes: 10 }];
const base: ItemDeMidia = { contains_person: true, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null, variants: arquivo };

describe("situacaoDaMidia", () => {
  it("sem arquivo é arquivo_ausente, mesmo sem pessoa", () => {
    expect(situacaoDaMidia({ ...base, contains_person: false, variants: [] }, "2026-10-07")).toBe("arquivo_ausente");
  });
  it("sem pessoa não precisa de termo", () => {
    expect(situacaoDaMidia({ ...base, contains_person: false }, "2026-10-07")).toBe("pronta");
  });
  it("com pessoa e sem assinatura é sem_termo", () => {
    expect(situacaoDaMidia(base, "2026-10-07")).toBe("sem_termo");
  });
  it("assinado sem validade é pronta", () => {
    expect(situacaoDaMidia({ ...base, consent_signed_at: "2026-10-01" }, "2026-10-07")).toBe("pronta");
  });
  it("validade de hoje ainda vale; de ontem venceu", () => {
    const assinado = { ...base, consent_signed_at: "2026-10-01" };
    expect(situacaoDaMidia({ ...assinado, consent_expires_at: "2026-10-07" }, "2026-10-07")).toBe("pronta");
    expect(situacaoDaMidia({ ...assinado, consent_expires_at: "2026-10-06" }, "2026-10-07")).toBe("termo_vencido");
  });
  it("revogado vence tudo, inclusive validade futura", () => {
    expect(
      situacaoDaMidia({ ...base, consent_signed_at: "2026-10-01", consent_expires_at: "2030-01-01", consent_revoked_at: "2026-10-05T10:00:00Z" }, "2026-10-07"),
    ).toBe("revogada");
  });
});

describe("hojeNaClinica", () => {
  it("usa o fuso de São Paulo: 01:30 UTC ainda é o dia anterior", () => {
    expect(hojeNaClinica(new Date("2026-10-08T01:30:00Z"))).toBe("2026-10-07");
  });
});
