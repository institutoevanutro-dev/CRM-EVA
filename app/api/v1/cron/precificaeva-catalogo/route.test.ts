import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: {
  INTERNAL_SECRET: "segredo",
  INTERNAL_CRON_SECRET: "",
  PRECIFICAEVA_ORGANIZATION_ID: "11111111-1111-4111-8111-111111111111",
  PRECIFICAEVA_URL: "https://ficticio.test/functions/v1/tabela-precos",
  PRECIFICAEVA_TOKEN: "x".repeat(32),
} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/integrations/precificaeva/catalogo", () => ({
  configPrecificaEva: vi.fn(() => ({ url: "https://ficticio.test/functions/v1/tabela-precos", token: "x".repeat(32) })),
  sincronizarCatalogo: vi.fn(async () => ({ inseridos: 2, atualizados: 1, desativados: 0 })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { configPrecificaEva, sincronizarCatalogo } from "@/lib/integrations/precificaeva/catalogo";
import { GET } from "./route";

async function comEnv(troca: Record<string, string>, fn: () => Promise<void>) {
  const e = env as unknown as Record<string, string | undefined>;
  const antes = { ...e };
  Object.assign(e, troca);
  try { await fn(); } finally { Object.assign(e, antes); }
}
const req = (secret?: string) => new NextRequest("http://localhost/api/v1/cron/precificaeva-catalogo", {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

beforeEach(() => vi.clearAllMocks());

describe("cron catálogo do PrecificaEva", () => {
  it("recusa chamada sem segredo e não toca no banco", async () => {
    expect((await GET(req())).status).toBe(403);
    expect((await GET(req("errado"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it("roda autenticada e devolve só contagens", async () => {
    const r = await GET(req("segredo"));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ inseridos: 2, atualizados: 1, desativados: 0 });
    expect(sincronizarCatalogo).toHaveBeenCalledTimes(1);
  });
  it("sem a integração configurada, pula com 200", async () => {
    await comEnv({ PRECIFICAEVA_ORGANIZATION_ID: "", PRECIFICAEVA_URL: "", PRECIFICAEVA_TOKEN: "" }, async () => {
      const r = await GET(req("segredo"));
      expect(r.status).toBe(200);
      expect((await r.json()).data).toEqual({ skipped: "not_configured" });
      expect(createAdminClient).not.toHaveBeenCalled();
    });
  });
  it("configurada pela metade continua 503", async () => {
    vi.mocked(configPrecificaEva).mockReturnValueOnce(null);
    await comEnv({ PRECIFICAEVA_TOKEN: "" }, async () => {
      expect((await GET(req("segredo"))).status).toBe(503);
    });
  });
  it("PrecificaEva fora do ar vira 503 sem vazar detalhe", async () => {
    vi.mocked(sincronizarCatalogo).mockRejectedValueOnce(new Error("detalhe interno"));
    const r = await GET(req("segredo"));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("detalhe interno");
  });
});
