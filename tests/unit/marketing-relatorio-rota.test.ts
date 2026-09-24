import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/plataformas-de-anuncio/meta/relatorio-servidor", () => ({
  relatorioDeCampanhas: mock,
}));
import { GET } from "@/app/api/v1/integrations/marketing/report/route";
const org = "10000000-0000-4000-8000-000000000001";
const token = "x".repeat(40);
const url =
  "https://crm.test/api/v1/integrations/marketing/report?account_id=act_123&from=2026-09-01&to=2026-09-07";
const req = (t?: string) => new NextRequest(url, { headers: t ? { "x-integracao-token": t } : {} });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MARKETING_ORGANIZATION_ID", org);
  vi.stubEnv("MARKETING_REPORT_TOKEN", token);
  mock.mockResolvedValue({ ok: true, dados: { campanhas: [], financeiro: "disponivel" } });
});
afterEach(() => vi.unstubAllEnvs());
it("sem segredo ou com segredo errado não consulta dados", async () => {
  expect((await GET(req())).status).toBe(401);
  expect((await GET(req("outro"))).status).toBe(401);
  expect(mock).not.toHaveBeenCalled();
});
it("organização é fixada no servidor e resposta contém só agregados", async () => {
  const r = await GET(req(token));
  expect(r.status).toBe(200);
  expect(mock).toHaveBeenCalledWith({
    organizacao: org,
    conta: "act_123",
    de: "2026-09-01",
    ate: "2026-09-07",
  });
  expect((await r.json()).data).toEqual({ campanhas: [], financeiro: "disponivel" });
  expect(r.headers.get("cache-control")).toBe("no-store");
});
