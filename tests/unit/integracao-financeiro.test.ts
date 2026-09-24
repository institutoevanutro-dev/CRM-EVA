import { afterEach, expect, it, vi } from "vitest";
import { configFinanceiro, consultaFinanceiro } from "@/lib/integrations/financeiro/cliente";
const org = "10000000-0000-4000-8000-000000000001";
const id = "20000000-0000-4000-8000-000000000002";
const env = {
  FINANCEIRO_URL: "https://financeiro.example.test",
  FINANCEIRO_ORGANIZATION_ID: org,
  FINANCEIRO_TOKEN: "x".repeat(40),
};
afterEach(() => vi.unstubAllGlobals());
it("configuração ausente ou de outra organização não habilita acesso", () => {
  expect(configFinanceiro(org, {})).toBeNull();
  expect(configFinanceiro(id, env)).toBeNull();
  expect(
    configFinanceiro(org, { ...env, FINANCEIRO_URL: "http://financeiro.example.test" }),
  ).toBeNull();
});
it("consulta envia token apenas em header e retorna links calculados localmente", async () => {
  const f = vi.fn().mockResolvedValue(Response.json({ data: null }));
  vi.stubGlobal("fetch", f);
  const c = configFinanceiro(org, env)!;
  const r = await consultaFinanceiro(c, id);
  expect(r.resumo).toBeNull();
  expect(r.abrir_url).toBe(`https://financeiro.example.test/pacientes/crm?contato=${id}`);
  expect(f.mock.calls[0]![1]).toMatchObject({
    headers: { "x-integracao-token": env.FINANCEIRO_TOKEN },
    cache: "no-store",
    redirect: "error",
  });
});
it("resposta inválida e falha de rede não viram saldo zero", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: { vendas: [] } })));
  await expect(consultaFinanceiro(configFinanceiro(org, env)!, id)).rejects.toThrow(/indisponível/);
});
