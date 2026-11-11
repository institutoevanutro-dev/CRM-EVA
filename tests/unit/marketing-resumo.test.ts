import { describe, expect, it } from "vitest";
import { anuncioDe, consultaResumo, montarResumo } from "@/lib/integrations/marketing/resumo";
import { consultaFunilPorOrigem } from "@/lib/integrations/marketing/funil-por-origem";

const AD = "120211234567890123";
describe("anuncioDe", () => {
  it("lê o sourceId do WAHA (camelCase) e o source_id da API oficial, só de anúncio da Meta", () => {
    expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { sourceId: AD } })).toBe(AD);
    expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { source_id: AD } })).toBe(AD);
    expect(anuncioDe({ adPlatform: "google_ads", adRaw: { sourceId: AD } })).toBeNull();
    expect(anuncioDe({ adPlatform: null, adRaw: null })).toBeNull();
  });
  it("post impulsionado não é anúncio", () => {
    expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { sourceId: AD, sourceType: "post" } })).toBeNull();
    expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { source_id: AD, source_type: "post" } })).toBeNull();
    expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { sourceId: AD, sourceType: "ad" } })).toBe(AD);
  });
  it("código que não é número de anúncio não conta", () => {
    for (const s of ["abc", "123", "1".repeat(21), "", " 120211234567890123"]) expect(anuncioDe({ adPlatform: "meta_ads", adRaw: { sourceId: s } })).toBeNull();
  });
});

describe("montarResumo", () => {
  const vazio = { leads: [], agendamentos: [], comparecimentos: [], sinais: [], ganhos: [] };
  it("totais de tudo, por anúncio só quem tem código, e leads sem anúncio", () => {
    const r = montarResumo({
      leads: [{ contactId: "c1" }, { contactId: "c1" }, { contactId: "c2" }, { contactId: null }, { contactId: "c3" }],
      agendamentos: [{ contactId: "c1" }, { contactId: "c2" }],
      comparecimentos: [{ contactId: "c1" }],
      sinais: [{ contactId: "c1" }],
      ganhos: [{ contactId: "c1", valueCents: 150000 }, { contactId: "c2", valueCents: null }],
    }, new Map([["c1", AD]]));
    expect(r.currency).toBe("BRL");
    expect(r.totais).toEqual({ leads: 5, agendamentos: 2, comparecimentos: 1, sinais: 1, ganhos: 2, ganhos_sem_valor: 1, receita_cents: "150000" });
    expect(r.por_anuncio).toEqual([{ anuncio: AD, leads: 2, agendamentos: 1, comparecimentos: 1, sinais: 1, ganhos: 1, ganhos_sem_valor: 0, receita_cents: "150000" }]);
    // Sem anúncio da Meta: c2, o lead sem contato e c3 (Google).
    expect(r.leads_sem_anuncio).toBe(3);
  });
  it("leads sem anúncio + leads por anúncio = total de leads", () => {
    const B = "120219999999999999";
    const r = montarResumo({ ...vazio, leads: [{ contactId: "c1" }, { contactId: "c2" }, { contactId: "c2" }, { contactId: "c3" }, { contactId: null }] },
      new Map([["c1", AD], ["c2", B]]));
    expect(r.leads_sem_anuncio + r.por_anuncio.reduce((t, x) => t + x.leads, 0)).toBe(r.totais.leads);
    expect(r.leads_sem_anuncio).toBe(2);
  });
  it("vazio dá zeros e lista vazia", () => {
    const r = montarResumo(vazio, new Map());
    expect(r.por_anuncio).toEqual([]);
    expect(r.totais.receita_cents).toBe("0");
    expect(r.leads_sem_anuncio).toBe(0);
  });
  it("não carrega id de contato", () => {
    const r = montarResumo({ ...vazio, leads: [{ contactId: "c-secreto" }] }, new Map([["c-secreto", AD]]));
    expect(JSON.stringify(r)).not.toContain("c-secreto");
  });
  it("receita grande não perde precisão", () => {
    const r = montarResumo({ ...vazio, ganhos: [{ contactId: "c1", valueCents: 9_007_199_254_740_991 }, { contactId: "c1", valueCents: 10 }] }, new Map([["c1", AD]]));
    expect(r.totais.receita_cents).toBe("9007199254741001");
  });
});

function clienteFalso(falhar = false) {
  const consultas: { tabela: string; filtros: string[] }[] = [];
  const linhas: Record<string, unknown[]> = {
    crm_leads: [{ contact_id: "c1", value_cents: 1000, tags: [], source: null }],
    calendar_appointments: [{ contact_id: "c1" }],
    contacts: [{ id: "c1", ad_platform: "meta_ads", ad_raw: { sourceId: "120211234567890123" } }],
    // Uma etapa de sinal pago, para a leitura dos sinais (event_log + crm_leads por id) também passar pelo teste.
    organizations: [{ settings: { conversoes: { etapas_de_sinal_pago: ["20000000-0000-4000-8000-000000000002"] } } }],
    event_log: [{ entity_id: "l1" }],
  };
  const montar = (tabela: string) => {
    const q = { tabela, filtros: [] as string[] };
    consultas.push(q);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "or", "gte", "lt", "order", "is", "neq", "in"]) b[m] = () => b;
    b.eq = (col: string, v: unknown) => { q.filtros.push(`${col}=${String(v)}`); return b; };
    b.range = async () => (falhar ? { data: null, error: { message: "x" } } : { data: linhas[tabela] ?? [], error: null });
    b.maybeSingle = async () => ({ data: linhas[tabela]?.[0] ?? null, error: null });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: linhas[tabela] ?? [], error: null }).then(ok);
    return b;
  };
  return { cliente: { from: montar }, consultas };
}

it("toda consulta filtra a organização configurada", async () => {
  const org = "10000000-0000-4000-8000-000000000001";
  const { cliente, consultas } = clienteFalso();
  const r = await consultaResumo(cliente as never, org, "2026-11-01", "2026-11-07");
  expect(consultas.length).toBeGreaterThan(4);
  expect(consultas.map((q) => q.tabela)).toContain("event_log");
  // Em `organizations` a própria linha é a organização: o filtro é pelo `id`.
  for (const q of consultas) expect(q.filtros, q.tabela).toContain(`${q.tabela === "organizations" ? "id" : "organization_id"}=${org}`);
  expect(r.por_anuncio[0]?.anuncio).toBe("120211234567890123");
});

it("o funil por origem não lê comparecimentos", async () => {
  const { cliente, consultas } = clienteFalso();
  await consultaFunilPorOrigem(cliente as never, "10000000-0000-4000-8000-000000000001", "2026-11-01", "2026-11-07");
  expect(consultas.some((q) => q.filtros.includes("status=completed"))).toBe(false);
});

it("o resumo lê comparecimentos (status completed)", async () => {
  const { cliente, consultas } = clienteFalso();
  await consultaResumo(cliente as never, "10000000-0000-4000-8000-000000000001", "2026-11-01", "2026-11-07");
  expect(consultas.some((q) => q.tabela === "calendar_appointments" && q.filtros.includes("status=completed"))).toBe(true);
});

it("erro de leitura diz de onde veio", async () => {
  const { cliente } = clienteFalso(true);
  await expect(consultaResumo(cliente as never, "10000000-0000-4000-8000-000000000001", "2026-11-01", "2026-11-07")).rejects.toThrow(/^eventos_do_periodo:/);
});
