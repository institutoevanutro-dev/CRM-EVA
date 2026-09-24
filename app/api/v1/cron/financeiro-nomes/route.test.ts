import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: {
  INTERNAL_SECRET: "segredo",
  INTERNAL_CRON_SECRET: "",
  FINANCEIRO_ORGANIZATION_ID: "11111111-1111-4111-8111-111111111111",
  FINANCEIRO_URL: "https://financeiro.example.test",
  FINANCEIRO_TOKEN: "x".repeat(32),
} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/integrations/financeiro/cliente", () => ({
  configFinanceiro: vi.fn(() => ({ url: "https://financeiro.example.test", token: "x".repeat(32) })),
}));
vi.mock("@/lib/integrations/financeiro/sincronizar-nomes", () => ({
  sincronizarNomesFinanceiro: vi.fn(async () => ({ consultados: 2, atualizados: 1, falhas: 0 })),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import { sincronizarNomesFinanceiro } from "@/lib/integrations/financeiro/sincronizar-nomes";
import { GET } from "./route";

const req = (secret?: string) => new NextRequest("http://localhost/api/v1/cron/financeiro-nomes", {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

beforeEach(() => vi.clearAllMocks());

describe("cron Financeiro nomes", () => {
  it("recusa chamadas sem segredo e não consulta pacientes", async () => {
    expect((await GET(req())).status).toBe(403);
    expect((await GET(req("errado"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
  it("executa lote autenticado e retorna apenas contagens", async () => {
    const resposta = await GET(req("segredo"));
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).data).toEqual({ consultados: 2, atualizados: 1, falhas: 0 });
    expect(sincronizarNomesFinanceiro).toHaveBeenCalledTimes(1);
  });
});
