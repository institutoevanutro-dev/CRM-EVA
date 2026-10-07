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
import { env } from "@/lib/env";
import { configFinanceiro } from "@/lib/integrations/financeiro/cliente";
import { sincronizarNomesFinanceiro } from "@/lib/integrations/financeiro/sincronizar-nomes";
import { GET } from "./route";

/** Roda `fn` com as variáveis do Financeiro trocadas, e devolve o env como estava. */
async function comEnv(troca: Record<string, string>, fn: () => Promise<void>) {
  const e = env as unknown as Record<string, string | undefined>;
  const antes = { ...e };
  Object.assign(e, troca);
  try {
    await fn();
  } finally {
    Object.assign(e, antes);
  }
}

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
  it("sem a integração configurada, a rodada é pulada com 200 — não é falha", async () => {
    // O scheduler escreve no log toda rodada que não volta 2xx (entrypoint.sh,
    // `|| echo FALHOU`). A integração é opcional e nasce vazia no .env.example:
    // um 503 aqui seriam 144 falhas falsas por dia em toda instalação sem ela.
    await comEnv({ FINANCEIRO_ORGANIZATION_ID: "", FINANCEIRO_URL: "", FINANCEIRO_TOKEN: "" }, async () => {
      const resposta = await GET(req("segredo"));
      expect(resposta.status).toBe(200);
      expect((await resposta.json()).data).toEqual({ skipped: "not_configured" });
      expect(createAdminClient).not.toHaveBeenCalled();
    });
  });
  it("configurada pela metade continua 503 — essa falha o operador precisa ver", async () => {
    vi.mocked(configFinanceiro).mockReturnValueOnce(null);
    await comEnv({ FINANCEIRO_TOKEN: "" }, async () => {
      expect((await GET(req("segredo"))).status).toBe(503);
    });
  });
});
