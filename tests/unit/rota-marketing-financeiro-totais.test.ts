import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ config: vi.fn(), consulta: vi.fn() }));
vi.mock("@/lib/integrations/financeiro/cliente", () => ({ configFinanceiro: m.config }));
vi.mock("@/lib/integrations/financeiro/totais-marketing", () => ({ consultaTotaisMarketing: m.consulta }));
import { GET } from "@/app/api/v1/integrations/marketing/financeiro-totais/route";

const org = "10000000-0000-4000-8000-000000000001";
const segredo = "t".repeat(40);
const req = (de = "2026-09-01", ate = "2026-09-07", token = segredo) => new NextRequest(
  `https://crm.eva.test/api/v1/integrations/marketing/financeiro-totais?de=${de}&ate=${ate}`,
  { headers: { "x-integracao-token": token } },
);
beforeEach(() => {
  vi.clearAllMocks();
  process.env.MARKETING_REPORT_TOKEN = segredo;
  process.env.MARKETING_ORGANIZATION_ID = org;
  m.config.mockReturnValue({ url: "https://financeiro.eva.test", token: "f".repeat(40) });
  m.consulta.mockResolvedValue({ currency: "BRL", vendas: { quantidade: 1, valor_cents: "82644" }, caixa: { recebido_cents: "82644" } });
});

it("bloqueia credencial inválida antes de chamar o Financeiro", async () => {
  const r = await GET(req(undefined, undefined, "incorreto"));
  expect(r.status).toBe(401);
  expect(m.config).not.toHaveBeenCalled();
  expect(m.consulta).not.toHaveBeenCalled();
});

it("devolve só agregados e usa a organização configurada", async () => {
  const r = await GET(req());
  expect(r.status).toBe(200);
  expect(m.config).toHaveBeenCalledWith(org);
  expect(m.consulta).toHaveBeenCalledWith(expect.anything(), "2026-09-01", "2026-09-07");
  const body = await r.json();
  expect(body.data.vendas).toEqual({ quantidade: 1, valor_cents: "82644" });
  expect(JSON.stringify(body)).not.toMatch(/paciente|contato|cpf|telefone/);
});

it("não converte indisponibilidade em zero", async () => {
  m.consulta.mockRejectedValue(new Error("fora do ar"));
  const r = await GET(req());
  expect(r.status).toBe(503);
  expect((await r.json()).data).toBeUndefined();
});
