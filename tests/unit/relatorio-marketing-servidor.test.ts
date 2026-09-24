import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  db: vi.fn(),
  cred: vi.fn(),
  ads: vi.fn(),
  fuso: vi.fn(),
  config: vi.fn(),
  vendas: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.db }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais-de-leitura", () => ({
  lerCredencialDeLeitura: m.cred,
}));
vi.mock("@/lib/plataformas-de-anuncio/meta/insights", () => ({
  lerAnunciosDaConta: m.ads,
  lerFusoDaConta: m.fuso,
}));
vi.mock("@/lib/integrations/financeiro/cliente", () => ({
  configFinanceiro: m.config,
  consultaVendasPorContatos: m.vendas,
}));
import { relatorioDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/relatorio-servidor";
const org = "10000000-0000-4000-8000-000000000001";
const contato = "20000000-0000-4000-8000-000000000002";
let eq: ReturnType<typeof vi.fn>, gte: ReturnType<typeof vi.fn>, lt: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    gte: vi.fn(),
    lt: vi.fn(),
    order: vi.fn(),
    range: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.gte.mockReturnValue(chain);
  chain.lt.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  chain.range.mockResolvedValue({
    data: [
      {
        id: contato,
        is_anonymized: false,
        source_metadata: { ad_platform: "meta_ads", ad_raw: { source_id: "120200001" } },
      },
      { id: "30000000-0000-4000-8000-000000000003", is_anonymized: false, source_metadata: {} },
    ],
    error: null,
  });
  eq = chain.eq;
  gte = chain.gte;
  lt = chain.lt;
  m.db.mockReturnValue({ from: vi.fn().mockReturnValue(chain) });
  m.cred.mockResolvedValue({ ok: true, credencial: { accessToken: "token-falso" } });
  m.ads.mockResolvedValue({ ok: true, dados: [{ id: "120200001", campaign_id: "120300001" }] });
  m.fuso.mockResolvedValue("America/Sao_Paulo");
  m.config.mockReturnValue({ url: "https://financeiro.test", token: "segredo-falso" });
  m.vendas.mockResolvedValue([
    { contato_id: contato, vendas: 1, valor_cents: "10000", recebido_cents: "3000" },
  ]);
});
it("filtra organização e dia da conta; envia ao Financeiro só contatos atribuídos", async () => {
  const r = await relatorioDeCampanhas({
    organizacao: org,
    conta: "act_123",
    de: "2026-09-01",
    ate: "2026-09-07",
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(eq).toHaveBeenCalledWith("organization_id", org);
  expect(gte).toHaveBeenCalledWith("created_at", "2026-09-01T03:00:00.000Z");
  expect(lt).toHaveBeenCalledWith("created_at", "2026-09-08T03:00:00.000Z");
  expect(m.vendas).toHaveBeenCalledWith(expect.anything(), [contato], "2026-09-01", "2026-09-07");
  expect(r.dados.campanhas).toEqual([
    {
      campanha_id: "120300001",
      contatos: 1,
      vendas: 1,
      valor_cents: "10000",
      recebido_cents: "3000",
    },
  ]);
  expect(r.dados.contatos_sem_campanha).toBe(1);
  expect(JSON.stringify(r.dados)).not.toContain(contato);
});
