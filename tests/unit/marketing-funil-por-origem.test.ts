import { describe, expect, it, vi } from "vitest";
import { montarFunil, origemDe, somarVendasPorOrigem } from "@/lib/integrations/marketing/funil-por-origem";

describe("origemDe", () => {
  it("anúncio vence etiqueta: quem clicou no anúncio da Meta é Meta, mesmo marcado como indicação", () => {
    expect(origemDe({ adPlatform: "meta_ads", tags: ["Indicação"] })).toBe("meta");
    expect(origemDe({ adPlatform: "google_ads", tags: [] })).toBe("google");
  });
  it("etiqueta Indicação, com ou sem acento e em qualquer caixa", () => {
    for (const t of ["Indicação", "indicacao", "INDICAÇÃO", " Indicacao "]) expect(origemDe({ adPlatform: null, tags: [t] })).toBe("indicacao");
  });
  it("etiqueta posta à mão Meta/Google vale quando falta a marca do anúncio; a marca automática vence", () => {
    for (const t of ["Meta", "meta", " Anúncio Meta "]) expect(origemDe({ adPlatform: null, tags: [t] })).toBe("meta");
    for (const t of ["Google", "Anuncio Google"]) expect(origemDe({ adPlatform: null, tags: [t] })).toBe("google");
    expect(origemDe({ adPlatform: null, tags: ["Meta", "Indicação"] })).toBe("meta");
    expect(origemDe({ adPlatform: "google_ads", tags: ["Meta"] })).toBe("google");
    expect(origemDe({ adPlatform: null, tags: ["meta_ads"] })).toBe("organico"); // a origem crua do lead não muda de regra
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
    expect(de("meta")).toEqual({ origem: "meta", leads: 2, agendamentos: 1, comparecimentos: 0, sinais: 1, ganhos: 2, ganhos_sem_valor: 1, receita_cents: "150000" });
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

  it("conta comparecimentos pela origem do contato", () => {
    const f = montarFunil(
      { leads: [], agendamentos: [], comparecimentos: [{ contactId: "c-meta" }, { contactId: "c-meta" }, { contactId: null }], sinais: [], ganhos: [] },
      new Map([["c-meta", "meta" as const]]),
    );
    expect(f.origens.find((l) => l.origem === "meta")?.comparecimentos).toBe(2);
    expect(f.origens.find((l) => l.origem === "organico")?.comparecimentos).toBe(1);
  });
});

describe("somarVendasPorOrigem", () => {
  it("soma o vendido e conta quem comprou, por origem; contato sem origem é orgânico; sem venda não conta", () => {
    const origens = new Map([["c-meta", "meta"], ["c-meta2", "meta"], ["c-goo", "google"]] as const);
    const s = somarVendasPorOrigem([
      { contato_id: "c-meta", vendas: 2, valor_cents: "300000", recebido_cents: "100000" },
      { contato_id: "c-meta2", vendas: 1, valor_cents: "50000", recebido_cents: "0" },
      { contato_id: "c-goo", vendas: 0, valor_cents: "0", recebido_cents: "0" },
      { contato_id: "c-x", vendas: 1, valor_cents: "70000", recebido_cents: "70000" },
    ], origens);
    expect(s.get("meta")).toEqual({ vendido: 350000n, compradores: 2 });
    expect(s.get("google")).toEqual({ vendido: 0n, compradores: 0 });
    expect(s.get("organico")).toEqual({ vendido: 70000n, compradores: 1 });
  });
});

describe("consultaFunilPorOrigem com vendas", () => {
  it("id de contato fora do formato UUID RFC fica fora da consulta ao Financeiro, sem derrubar as vendas dos outros", async () => {
    const { consultaFunilPorOrigem } = await import("@/lib/integrations/marketing/funil-por-origem");
    const bom = "10000000-0000-4000-8000-000000000001";
    const legado = "10000000-0000-0000-0000-000000000002"; // versão 0: o Financeiro recusa
    const vazio = { data: [], error: null };
    const tabela = (nome: string) => {
      const q: Record<string, unknown> = {};
      const fim = () => Promise.resolve(nome === "contacts" ? { data: [{ id: bom, ad_platform: "meta_ads" }, { id: legado, ad_platform: null }], error: null } : vazio);
      for (const k of ["select", "eq", "in", "gte", "lte", "lt", "gt", "is", "not", "order", "range", "limit", "neq", "or", "filter"]) q[k] = () => q;
      q.then = (ok: (v: unknown) => unknown, nao: (e: unknown) => unknown) => fim().then(ok, nao);
      return q;
    };
    vi.doMock("@/lib/integrations/marketing/eventos-do-periodo", () => ({
      emLotes: (xs: string[]) => [xs],
      lerEventosDoPeriodo: async () => ({ leads: [{ contactId: bom }, { contactId: legado }], agendamentos: [], sinais: [], ganhos: [] }),
      lerComparecimentos: async () => [],
    }));
    vi.resetModules();
    const m = await import("@/lib/integrations/marketing/funil-por-origem");
    const pedidos: string[][] = [];
    const f = await m.consultaFunilPorOrigem({ from: tabela } as never, "org", "2026-10-01", "2026-10-30", async (lote) => {
      pedidos.push(lote);
      return [{ contato_id: bom, vendas: 1, valor_cents: "100000", recebido_cents: "0" }];
    });
    vi.doUnmock("@/lib/integrations/marketing/eventos-do-periodo");
    expect(pedidos).toEqual([[bom]]);
    expect(f.origens.find((o) => o.origem === "meta")?.vendido_cents).toBe("100000");
    void consultaFunilPorOrigem;
  });
});
