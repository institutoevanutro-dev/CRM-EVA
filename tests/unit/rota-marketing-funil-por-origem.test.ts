import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ consulta: vi.fn(), admin: vi.fn(() => ({ cliente: true })) }));
vi.mock("@/lib/integrations/marketing/funil-por-origem", () => ({ consultaFunilPorOrigem: m.consulta }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.admin }));
import { GET } from "@/app/api/v1/integrations/marketing/funil-por-origem/route";

const org = "10000000-0000-4000-8000-000000000001";
const segredo = "t".repeat(40);
const req = (de = "2026-10-01", ate = "2026-10-07", token = segredo) => new NextRequest(
  `https://crm.eva.test/api/v1/integrations/marketing/funil-por-origem?de=${de}&ate=${ate}`,
  { headers: { "x-integracao-token": token } },
);
const FUNIL = { currency: "BRL", origens: [{ origem: "meta", leads: 3, agendamentos: 1, sinais: 1, ganhos: 1, ganhos_sem_valor: 0, receita_cents: "150000" }] };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.MARKETING_REPORT_TOKEN = segredo;
  process.env.MARKETING_ORGANIZATION_ID = org;
  m.consulta.mockResolvedValue(FUNIL);
});

it("bloqueia credencial inválida antes de ler o banco", async () => {
  expect((await GET(req(undefined, undefined, "incorreto"))).status).toBe(401);
  expect(m.consulta).not.toHaveBeenCalled();
});

it("lê só a organização configurada, nunca uma vinda do pedido", async () => {
  const r = await GET(new NextRequest(`https://crm.eva.test/x?de=2026-10-01&ate=2026-10-07&organization_id=20000000-0000-4000-8000-000000000002`, { headers: { "x-integracao-token": segredo } }));
  expect(r.status).toBe(200);
  expect(m.consulta).toHaveBeenCalledWith(expect.anything(), org, "2026-10-01", "2026-10-07");
  expect((await r.json()).data).toEqual(FUNIL);
  expect(r.headers.get("cache-control")).toBe("no-store");
});

it("período inválido ou maior que 90 dias: 422", async () => {
  for (const [de, ate] of [["2026-10-07", "2026-10-01"], ["2026-01-01", "2026-06-01"], ["ontem", "2026-10-01"]])
    expect((await GET(req(de, ate))).status).toBe(422);
  expect(m.consulta).not.toHaveBeenCalled();
});

it("sem organização configurada: 503; leitura que falha não vira zero", async () => {
  delete process.env.MARKETING_ORGANIZATION_ID;
  expect((await GET(req())).status).toBe(503);
  process.env.MARKETING_ORGANIZATION_ID = org;
  m.consulta.mockRejectedValueOnce(new Error("x"));
  const r = await GET(req());
  expect(r.status).toBe(503);
  expect(JSON.stringify(await r.json())).not.toMatch(/"leads"/);
});
