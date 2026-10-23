import { describe, expect, it } from "vitest";
import { montarFunil, origemDe } from "@/lib/integrations/marketing/funil-por-origem";

describe("origemDe", () => {
  it("anúncio vence etiqueta: quem clicou no anúncio da Meta é Meta, mesmo marcado como indicação", () => {
    expect(origemDe({ adPlatform: "meta_ads", tags: ["Indicação"] })).toBe("meta");
    expect(origemDe({ adPlatform: "google_ads", tags: [] })).toBe("google");
  });
  it("etiqueta Indicação, com ou sem acento e em qualquer caixa", () => {
    for (const t of ["Indicação", "indicacao", "INDICAÇÃO", " Indicacao "]) expect(origemDe({ adPlatform: null, tags: [t] })).toBe("indicacao");
  });
  it("o resto é orgânico, inclusive plataforma desconhecida", () => {
    expect(origemDe({ adPlatform: null, tags: ["Meta_ads_antigo"] })).toBe("organico");
    expect(origemDe({ adPlatform: "tiktok", tags: [] })).toBe("organico");
  });
});

describe("montarFunil", () => {
  const origens = new Map([["c-meta", "meta"], ["c-ind", "indicacao"]] as const);
  it("as quatro origens sempre aparecem, na mesma ordem, mesmo zeradas", () => {
    const f = montarFunil({ leads: [], agendamentos: [], sinais: [], ganhos: [] }, new Map());
    expect(f.currency).toBe("BRL");
    expect(f.origens.map((o) => o.origem)).toEqual(["meta", "google", "indicacao", "organico"]);
    expect(f.origens.every((o) => o.leads === 0 && o.receita_cents === "0")).toBe(true);
  });
  it("conta por origem do contato; contato desconhecido cai em orgânico", () => {
    const f = montarFunil({
      leads: [{ contactId: "c-meta" }, { contactId: "c-meta" }, { contactId: null }],
      agendamentos: [{ contactId: "c-meta" }, { contactId: "c-ind" }],
      sinais: [{ contactId: "c-meta" }],
      ganhos: [{ contactId: "c-meta", valueCents: 150000 }, { contactId: "c-meta", valueCents: null }, { contactId: "c-ind", valueCents: 90000 }],
    }, origens);
    const de = (o: string) => f.origens.find((x) => x.origem === o)!;
    expect(de("meta")).toEqual({ origem: "meta", leads: 2, agendamentos: 1, sinais: 1, ganhos: 2, ganhos_sem_valor: 1, receita_cents: "150000" });
    expect(de("indicacao")).toMatchObject({ agendamentos: 1, ganhos: 1, receita_cents: "90000" });
    expect(de("organico").leads).toBe(1);
  });
  it("receita vai como texto de dígitos e não perde precisão em soma grande", () => {
    const f = montarFunil({ leads: [], agendamentos: [], sinais: [], ganhos: [{ contactId: "c-meta", valueCents: 9_007_199_254_740_991 }, { contactId: "c-meta", valueCents: 10 }] }, origens);
    expect(f.origens[0]?.receita_cents).toBe("9007199254741001");
  });
  it("não carrega nada que identifique paciente", () => {
    const f = montarFunil({ leads: [{ contactId: "c-meta" }], agendamentos: [], sinais: [], ganhos: [] }, origens);
    expect(JSON.stringify(f)).not.toContain("c-meta");
  });
});
